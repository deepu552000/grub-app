// app/api/debug-kv/route.ts
// GET /api/debug-kv
// Scans all grub pet keys and returns full user + referral state.
// Protected by Clerk — requires a valid session token in Authorization header.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";
import { getAllFidsForApp, getAllAddedFids, getWebhookEventLog } from "@/lib/notification-tokens";
import { getCredits } from "@/lib/grub-credits";

const APP_FID = 9152;

export async function GET(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // ── Basic connectivity check ──────────────────────────────────────────
    await kv.set("test:ping", "pong");
    const ping = await kv.get("test:ping");

    // ── Scan all grub pet keys ────────────────────────────────────────────
    const keys = await kv.keys("grub:pet:*");
    // kv.keys() is a prefix glob, not exact-segment aware — it also matches
    // lib/grub-credits.ts's atomic per-user credit keys, which are stored as
    // "grub:pet:<fid>:credit:free" / "...:credit:streak" (so the atomic
    // kv.incrby/decrby never touches the same key as the main state blob).
    // Those aren't pet records at all, but before this filter every match
    // got treated as its own fid — stripping the "grub:pet:" prefix off
    // "grub:pet:3325017:credit:free" left the bogus "fid" 3325017:credit:free,
    // which (having no real pet state) landed straight in Unconverted Opens.
    // A genuine pet key is always either a plain numeric fid or a
    // "wallet:0x..." key (see lib/pet-key.ts) — nothing else qualifies.
    const petFids = keys
      .map((key) => key.replace("grub:pet:", ""))
      .filter((rest) => /^\d+$/.test(rest) || rest.startsWith("wallet:"));

    // Fids that have a stored Farcaster notification token (i.e. notifs
    // are currently ON for them).
    const notifFids = new Set(await getAllFidsForApp(APP_FID));
    // Fids that have added the mini app, regardless of notif status.
    // Tracked independently of notifFids — see lib/notification-tokens.ts.
    const addedFids = new Set(await getAllAddedFids(APP_FID));

    // Raw webhook event log — last 500, newest first. Our paper trail
    // since we don't have Vercel log drains (Pro-only).
    const webhookEvents = await getWebhookEventLog(500);

    // Union of every fid we know about from any source — pet state,
    // notif tokens, or "added" events — so someone who added the app but
    // never opened it (no grub:pet:* key) still shows up everywhere.
    const allFids = new Set<string>([
      ...petFids,
      ...[...notifFids].map(String),
      ...[...addedFids].map(String),
    ]);

    const users = await Promise.all(
      [...allFids].map(async (fid) => {
        const state = await kv.get<any>(`grub:pet:${fid}`);

        const hasNotifToken = notifFids.has(Number(fid));
        const hasAddedApp = addedFids.has(Number(fid));

        // Base App wallet identities (fid === "wallet:0x...") use a completely
        // separate KV keyspace for referrals — "refbase:"/"referrerbase:" —
        // written by registerReferralBase() in lib/referral.ts (see comment
        // there: kept distinct on purpose, never shares a code path with the
        // FC fid-based "ref:"/"referrer:" keys). Reading only the FC keys
        // here meant every Base referral silently vanished from this
        // dashboard, so we branch on identity type and read whichever
        // keyspace actually matches this fid.
        const isWallet = fid.startsWith("wallet:");
        const walletAddr = isWallet ? fid.slice("wallet:".length).toLowerCase() : null;

        const referredUsers: (number | string)[] = isWallet
          ? await kv.get<string[]>(`referrerbase:${walletAddr}:referred`) ?? []
          : await kv.get<number[]>(`referrer:${fid}:referred`) ?? [];

        const referredByRaw = isWallet
          ? await kv.get<string>(`refbase:${walletAddr}`)
          : await kv.get<string>(`ref:${fid}`);
        // Base referrers are stored as bare lowercase addresses (no "wallet:"
        // prefix — see registerReferralBase); re-add the prefix here so this
        // matches the same fid convention used everywhere else in the app.
        const referredByFid = referredByRaw
          ? (isWallet ? `wallet:${referredByRaw}` : referredByRaw)
          : null;

        const referralDetails = await Promise.all(
          referredUsers.map(async (refFid) => {
            const checkins = isWallet
              ? await kv.get<number>(`refbase:${refFid}:checkins`) ?? 0
              : await kv.get<number>(`ref:${refFid}:checkins`) ?? 0;
            const status = isWallet
              ? await kv.get<string>(`refbase:${refFid}:status`) ?? "joined"
              : await kv.get<string>(`ref:${refFid}:status`) ?? "joined";
            // Same re-prefixing as above, so referred-user fids in the
            // response are always either a numeric fid or "wallet:0x...".
            const displayFid = isWallet ? `wallet:${refFid}` : refFid;
            return { fid: displayFid, checkins, status };
          })
        );

        const degenEarned =
          referralDetails.filter((r) => r.status === "paid").length * 2 +
          referralDetails.length * 1;

        // Real atomic credit balances — NOT read from the blob (which is
        // only ever a best-effort mirror, see lib/grub-credits.ts). Fetched
        // for every fid, including noPetState ones below (a fid can only
        // ever have credits if it has pet state, but this keeps the field
        // consistently present either way rather than sometimes missing).
        const credits = await getCredits(`grub:pet:${fid}`);

        // No pet state at all — added/notif-token-only fid that never
        // opened the mini-app. Still return a full record so it shows
        // up in the dashboard, just with zeroed-out pet stats.
        if (!state) {
          return {
            fid,
            noPetState: true,
            streak: 0,
            checkinStreak: 0,
            streakBug: false,
            totalCheckIns: 0,
            xp: 0,
            bond: 0,
            glimmer: 0,
            hunger: 0,
            happiness: 0,
            lastCheckInDay: "never",
            lastVisit: "unknown",
            actionsToday: {},
            accessoriesUnlockedCount: 0,
            accessoriesUnlocked: [],
            freeCheckinCredits: credits.freeCheckinCredits,
            streakSaveCredits: credits.streakSaveCredits,
            hasNotifToken,
            hasAddedApp,
            referrals: {
              referredBy: referredByFid && !isWallet ? Number(referredByFid) : referredByFid,
              referredCount: referredUsers.length,
              referredUsers: referralDetails,
              degenEarned,
            },
          };
        }

        // streak (lifetime check-in count, never resets) and checkinStreak
        // (consecutive run, resets to 1 only on a missed day — it's
        // allowed to keep climbing past 7 indefinitely, e.g. 8, 14, 21...
        // as long as the user never misses a day) are different counters
        // by design and will legitimately diverge. The only truly
        // impossible state is checkinStreak exceeding streak, since the
        // consecutive run can never be longer than the lifetime total.
        const streakBug = (state.checkinStreak ?? 0) > (state.streak ?? 0);

        const unlockedAccessories: string[] = Array.isArray(state.accessories?.unlocked)
          ? state.accessories.unlocked
          : [];

        return {
          fid,
          streak: state.streak,
          checkinStreak: state.checkinStreak,
          streakBug,
          totalCheckIns: state.totalCheckIns ?? 0,
          xp: Math.floor(state.xp ?? 0),
          bond: state.bond ?? 0,
          glimmer: state.glimmer ?? 0,
          hunger: state.hunger ?? 0,
          happiness: state.happiness ?? 0,
          lastCheckInDay: state.lastCheckInDay ?? "never",
          lastVisit: state.lastVisit
            ? new Date(state.lastVisit).toISOString()
            : "unknown",
          actionsToday: state.actionsToday ?? {},
          accessoriesUnlockedCount: unlockedAccessories.length,
          accessoriesUnlocked: unlockedAccessories,
          freeCheckinCredits: credits.freeCheckinCredits,
          streakSaveCredits: credits.streakSaveCredits,
          hasNotifToken,
          hasAddedApp,
          referrals: {
            referredBy: referredByFid && !isWallet ? Number(referredByFid) : referredByFid,
            referredCount: referredUsers.length,
            referredUsers: referralDetails,
            degenEarned,
          },
        };
      })
    );

    const bugged = users.filter((u) => (u as any).streakBug);
    const usersWithAccessories = users.filter(
      (u) => ((u as any).accessoriesUnlockedCount ?? 0) > 0
    );
    const notifiableCount = users.filter((u) => (u as any).hasNotifToken).length;
    const addedCount = users.filter((u) => (u as any).hasAddedApp).length;
    const addedButNotifOff = users.filter(
      (u) => (u as any).hasAddedApp && !(u as any).hasNotifToken
    );

    return NextResponse.json({
      ping,
      totalUsers: users.length,
      petOnlyUserCount: petFids.length,
      webhookEvents,
      notifiableCount,
      addedCount,
      addedButNotifOffCount: addedButNotifOff.length,
      addedButNotifOff: addedButNotifOff.map((u) => (u as any).fid),
      buggedStreakCount: bugged.length,
      usersWithAccessoriesCount: usersWithAccessories.length,
      users,
      streakFixNeeded: bugged.map((u) => ({
        fid: (u as any).fid,
        streak: (u as any).streak,
        checkinStreak: (u as any).checkinStreak,
      })),
      accessoryUnlockers: usersWithAccessories.map((u) => ({
        fid: (u as any).fid,
        accessoriesUnlockedCount: (u as any).accessoriesUnlockedCount,
        accessoriesUnlocked: (u as any).accessoriesUnlocked,
      })),
      referralSummary: users
        .filter((u) => ((u as any).referrals?.referredCount ?? 0) > 0)
        .map((u) => ({
          fid: (u as any).fid,
          referredCount: (u as any).referrals.referredCount,
          referredUsers: (u as any).referrals.referredUsers,
          degenEarned: (u as any).referrals.degenEarned,
        })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message });
  }
}
