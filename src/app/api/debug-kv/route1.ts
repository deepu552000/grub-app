// app/api/debug-kv/route.ts
// GET /api/debug-kv
// Scans all grub pet keys and returns full user + referral state.
// Protected by Clerk — requires a valid session token in Authorization header.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";
import { getAllFidsForApp, getAllAddedFids, getWebhookEventLog } from "@/lib/notification-tokens";

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
    const petFids = keys.map((key) => key.replace("grub:pet:", ""));

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

        const referredUsers: number[] = await kv.get<number[]>(`referrer:${fid}:referred`) ?? [];
        const referredByFid = await kv.get<string>(`ref:${fid}`) ?? null;

        const referralDetails = await Promise.all(
          referredUsers.map(async (refFid) => {
            const checkins = await kv.get<number>(`ref:${refFid}:checkins`) ?? 0;
            const status = await kv.get<string>(`ref:${refFid}:status`) ?? "joined";
            return { fid: refFid, checkins, status };
          })
        );

        const degenEarned =
          referralDetails.filter((r) => r.status === "paid").length * 2 +
          referralDetails.length * 1;

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
            hasNotifToken,
            hasAddedApp,
            referrals: {
              referredBy: referredByFid ? Number(referredByFid) : null,
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
          hasNotifToken,
          hasAddedApp,
          referrals: {
            referredBy: referredByFid ? Number(referredByFid) : null,
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
