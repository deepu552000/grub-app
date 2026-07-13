// app/api/admin/user-control/route.ts
//
// Per-user admin controls for Grub. Two endpoints in one file:
//
//   GET  /api/admin/user-control?fid=<fid>&secret=<ADMIN_SECRET>
//        Returns the current pet state + referral info for that fid.
//
//   POST /api/admin/user-control
//        Body: { secret, fid, action, ...actionParams }
//        action = "revoke_accessory" | "unlock_accessory" | "adjust_stats"
//               | "grant_credit" | "ban" | "unban" | "edit_referral"
//
// NOTE on "ban": this sets a `banned: true/false` flag on the user's
// grub:pet:<fid> record. /api/pet checks this flag on every POST and
// rejects writes (403) for banned fids — feeding, unlocking, checking in,
// all blocked. A banned player can still load the app and see their pet,
// but can't take any action that writes state.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ACCESSORIES } from "@/lib/accessories";
import { getAuth } from "@clerk/nextjs/server";
import { registerReferral, registerReferralBase } from "@/lib/referral";
import { grantCredit, revokeCredit, getCredits } from "@/lib/grub-credits";
import { petKey } from "@/lib/pet-key";
import { getBalance, getCoinTossStatsForIdentity } from "@/lib/minigames";

const VALID_ACCESSORY_IDS = new Set(ACCESSORIES.map((a) => a.id));

function unauthorized() {
  return NextResponse.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
}

async function checkAuth(req: NextRequest) {
  try {
    const { userId } = getAuth(req);
    return !!userId;
  } catch {
    return false;
  }
}

async function getPetState(fid: string) {
  return await kv.get<any>(petKey(fid)!);
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) return unauthorized();

  const fid = req.nextUrl.searchParams.get("fid");
  if (!fid) {
    return NextResponse.json({ ok: false, reason: "missing fid" }, { status: 400 });
  }

  const state = await getPetState(fid);
  if (!state) {
    return NextResponse.json({ ok: false, reason: `no pet state found for fid ${fid}` });
  }

  // Base App wallet identities (fid === "wallet:0x...") use a separate
  // "refbase:"/"referrerbase:" keyspace — see the matching comment in
  // /api/debug-kv. Without this branch, looking up a Base user here would
  // silently return no referral info even when one exists.
  const isWallet = fid.startsWith("wallet:");
  const walletAddr = isWallet ? fid.slice("wallet:".length).toLowerCase() : null;

  const referredByRaw = isWallet
    ? await kv.get<string>(`refbase:${walletAddr}`)
    : await kv.get<string>(`ref:${fid}`);
  const referredByFid = referredByRaw
    ? (isWallet ? `wallet:${referredByRaw}` : referredByRaw)
    : null;

  const referredUsersRaw = isWallet
    ? (await kv.get<string[]>(`referrerbase:${walletAddr}:referred`)) ?? []
    : (await kv.get<number[]>(`referrer:${fid}:referred`)) ?? [];
  const referredUsers = isWallet
    ? referredUsersRaw.map((w) => `wallet:${w}`)
    : referredUsersRaw;
  // Read credits from the atomic keys, not the blob — the blob copy is only
  // a mirror and can lag by design (see lib/grub-credits.ts).
  const credits = await getCredits(petKey(fid)!);

  // Coin Toss internal balance + played stats for this same identity — the
  // identityKey minigames.ts keys everything under is exactly this fid
  // string (a numeric FID, or "wallet:0x..." for Base App users, same
  // convention already used everywhere else on this page). Balance is
  // shown regardless of play history (it's just their current wallet-in-
  // game number); the deeper won/lost/net figures only exist once
  // getCoinTossStatsForIdentity finds at least one flip, so `coinToss` is
  // null for a user who's never played — the dashboard hides that block
  // in that case instead of showing an all-zero table.
  const minigamesKey = petKey(fid)!;
  const [coinTossBalance, coinToss] = await Promise.all([
    getBalance(minigamesKey),
    getCoinTossStatsForIdentity(minigamesKey),
  ]);

  return NextResponse.json({
    ok: true,
    fid,
    state: {
      xp: Math.floor(state.xp ?? 0),
      bond: state.bond ?? 0,
      glimmer: state.glimmer ?? 0,
      hunger: state.hunger ?? 0,
      happiness: state.happiness ?? 0,
      totalCheckIns: state.totalCheckIns ?? 0,
      banned: state.banned ?? false,
      freeCheckinCredits: credits.freeCheckinCredits,
      streakSaveCredits: credits.streakSaveCredits,
      accessoriesUnlocked: state.accessories?.unlocked ?? [],
      accessoriesEquipped: state.accessories?.equipped ?? {},
    },
    referral: {
      referredByFid,
      referredUsers,
    },
    minigames: {
      coinTossBalance,
      // null when this identity has never placed a flip — dashboard should
      // hide the won/lost/net breakdown in that case, not render zeros.
      coinToss: coinToss
        ? {
            flips: coinToss.flips,
            wins: coinToss.wins,
            totalWagered: coinToss.totalWagered,
            betOnWins: coinToss.betOnWins,
            totalWon: coinToss.totalWon,
            totalLost: coinToss.totalLost,
            totalDeposited: coinToss.totalDeposited,
            netProfitLoss: coinToss.netProfitLoss,
          }
        : null,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { fid, action } = body;

    if (!fid || !action) {
      return NextResponse.json({ ok: false, reason: "missing fid or action" }, { status: 400 });
    }

    const key = petKey(fid)!;

    // ── Revoke a specific accessory ─────────────────────────────────────
    if (action === "revoke_accessory") {
      const { accessoryId } = body;
      if (!accessoryId) {
        return NextResponse.json({ ok: false, reason: "missing accessoryId" }, { status: 400 });
      }

      if (!VALID_ACCESSORY_IDS.has(accessoryId)) {
        return NextResponse.json({
          ok: false,
          reason: `unknown accessory "${accessoryId}". Valid IDs: ${[...VALID_ACCESSORY_IDS].join(", ")}`,
        }, { status: 400 });
      }

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const accessories = state.accessories ?? { unlocked: [], equipped: {} };
      if (!(accessories.unlocked ?? []).includes(accessoryId)) {
        return NextResponse.json({ ok: false, reason: `accessory "${accessoryId}" was not unlocked` });
      }

      const newUnlocked = accessories.unlocked.filter((id: string) => id !== accessoryId);
      const newEquipped = { ...accessories.equipped };
      for (const slot of Object.keys(newEquipped)) {
        if (newEquipped[slot] === accessoryId) delete newEquipped[slot];
      }

      await kv.set(key, {
        ...state,
        accessories: { unlocked: newUnlocked, equipped: newEquipped },
      });

      return NextResponse.json({ ok: true, fid, action, revoked: accessoryId, remainingUnlocked: newUnlocked });
    }

    // ── Unlock a specific accessory (admin grant) ───────────────────────
    if (action === "unlock_accessory") {
      const { accessoryId } = body;
      if (!accessoryId) {
        return NextResponse.json({ ok: false, reason: "missing accessoryId" }, { status: 400 });
      }

      if (!VALID_ACCESSORY_IDS.has(accessoryId)) {
        return NextResponse.json({
          ok: false,
          reason: `unknown accessory "${accessoryId}". Valid IDs: ${[...VALID_ACCESSORY_IDS].join(", ")}`,
        }, { status: 400 });
      }

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const accessories = state.accessories ?? { unlocked: [], equipped: {} };
      const alreadyUnlocked: string[] = accessories.unlocked ?? [];

      if (alreadyUnlocked.includes(accessoryId)) {
        return NextResponse.json({ ok: false, reason: `accessory "${accessoryId}" is already unlocked` });
      }

      const newUnlocked = [...alreadyUnlocked, accessoryId];
      await kv.set(key, {
        ...state,
        accessories: { ...accessories, unlocked: newUnlocked },
      });

      return NextResponse.json({ ok: true, fid, action, unlocked: accessoryId, allUnlocked: newUnlocked });
    }

    // ── Adjust stats directly ───────────────────────────────────────────
    if (action === "adjust_stats") {
      const { xp, bond, glimmer, hunger, happiness } = body;
      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const updated = {
        ...state,
        xp: typeof xp === "number" ? xp : state.xp,
        bond: typeof bond === "number" ? bond : state.bond,
        glimmer: typeof glimmer === "number" ? glimmer : state.glimmer,
        hunger: typeof hunger === "number" ? hunger : state.hunger,
        happiness: typeof happiness === "number" ? happiness : state.happiness,
      };

      await kv.set(key, updated);

      return NextResponse.json({
        ok: true,
        fid,
        action,
        newStats: { xp: updated.xp, bond: updated.bond, glimmer: updated.glimmer, hunger: updated.hunger, happiness: updated.happiness },
      });
    }

    // ── Grant a banked Spin Wheel credit (manual correction) ────────────
    // Use this to fix an account that won a Free Check-in or Streak Save
    // credit that never made it into KV — e.g. a save race wiped it. See
    // /api/pet's sanitizeState + the new "wheel_spin" branch for the
    // underlying fix; this action is just for patching an already-affected
    // account after the fact.
    if (action === "grant_credit") {
      const { creditType, amount } = body;

      if (creditType !== "freeCheckin" && creditType !== "streakSave") {
        return NextResponse.json(
          { ok: false, reason: `creditType must be "freeCheckin" or "streakSave", got "${creditType}"` },
          { status: 400 }
        );
      }

      const grantAmount = typeof amount === "number" && amount > 0 ? Math.floor(amount) : 1;

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      // Atomic INCRBY — same helper the wheel_spin win path uses, so a
      // manual correction here can never drift out of sync with a
      // concurrent player-triggered grant/spend on the same fid.
      const field = creditType === "freeCheckin" ? "freeCheckinCredits" : "streakSaveCredits";
      const newValue = await grantCredit(key, creditType, grantAmount);

      // Mirror into the blob so GET /api/admin/user-control and the
      // debug-kv dashboard stay accurate without extra plumbing — the
      // atomic key remains the real source of truth.
      await kv.set(key, { ...state, [field]: newValue });

      return NextResponse.json({ ok: true, fid, action, creditType, granted: grantAmount, newValue });
    }

    // ── Remove a banked Spin Wheel credit (manual correction) ───────────
    // Use this to undo an accidental double-grant, or to correct a count
    // that's too high for any other reason. Always succeeds and floors at
    // 0 — see revokeCredit() in lib/grub-credits.ts for why this is
    // deliberately different from the in-game spend path.
    if (action === "revoke_credit") {
      const { creditType, amount } = body;

      if (creditType !== "freeCheckin" && creditType !== "streakSave") {
        return NextResponse.json(
          { ok: false, reason: `creditType must be "freeCheckin" or "streakSave", got "${creditType}"` },
          { status: 400 }
        );
      }

      const revokeAmount = typeof amount === "number" && amount > 0 ? Math.floor(amount) : 1;

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const field = creditType === "freeCheckin" ? "freeCheckinCredits" : "streakSaveCredits";
      const newValue = await revokeCredit(key, creditType, revokeAmount);

      // Mirror into the blob, same as grant_credit above.
      await kv.set(key, { ...state, [field]: newValue });

      return NextResponse.json({ ok: true, fid, action, creditType, revoked: revokeAmount, newValue });
    }

    // ── Ban / unban ─────────────────────────────────────────────────────
    if (action === "ban" || action === "unban") {
      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      await kv.set(key, { ...state, banned: action === "ban" });

      return NextResponse.json({ ok: true, fid, action, banned: action === "ban" });
    }

    // ── Edit / remove referral relationship ─────────────────────────────
    if (action === "edit_referral") {
      const { newReferrerFid, removeReferral, triggerPayout } = body;

      // Base wallet identities (fid === "wallet:0x...") live in a separate
      // "refbase:"/"referrerbase:" keyspace — same split as debug-kv and
      // registerReferralBase() in lib/referral.ts. Everything below just
      // mirrors the FC branch one-for-one against that keyspace instead.
      const isWallet = typeof fid === "string" && fid.startsWith("wallet:");
      const walletAddr = isWallet ? fid.slice("wallet:".length).toLowerCase() : null;

      if (removeReferral) {
        if (isWallet) {
          await kv.del(`refbase:${walletAddr}`);
          await kv.del(`refbase:${walletAddr}:checkins`);
          await kv.del(`refbase:${walletAddr}:status`);
        } else {
          await kv.del(`ref:${fid}`);
          await kv.del(`ref:${fid}:checkins`);
          await kv.del(`ref:${fid}:status`);
        }
        return NextResponse.json({ ok: true, fid, action, removed: true });
      }

      if (newReferrerFid) {
        if (isWallet) {
          // The referrer must also be a Base wallet — the two identity
          // spaces never cross, same as the real join flow. Accept either
          // "wallet:0xabc..." or a bare address typed into the admin field.
          const referrerRaw = String(newReferrerFid);
          const referrerAddr = (
            referrerRaw.startsWith("wallet:") ? referrerRaw.slice("wallet:".length) : referrerRaw
          ).toLowerCase();

          // Guard against pasting the dashboard's shortened display label
          // (e.g. "wallet:0x1233....89893") instead of the real address —
          // that truncated form isn't a real key and would silently create
          // a referral pointing at a wallet that doesn't exist. A real
          // address is always exactly 0x + 40 hex chars, no "....".
          if (!/^0x[0-9a-f]{40}$/.test(referrerAddr)) {
            return NextResponse.json({
              ok: false,
              reason: `"${referrerRaw}" isn't a full wallet address. Paste the complete 0x address (42 characters), not the shortened label shown in the dashboard — e.g. 0x6619456623736bAF129D7C091026938443370f11.`,
            }, { status: 400 });
          }

          if (triggerPayout) {
            // Runs the SAME registerReferralBase() flow a real Base
            // referral link click triggers — KV writes and an actual
            // sendDegen payout. Mirrors the FC triggerPayout path below;
            // rejects the same way a real join would (self-referral,
            // already registered, existing activity) — use "Remove
            // Sponsor" first if you need to re-test this wallet.
            const result = await registerReferralBase(walletAddr!, referrerAddr);
            return NextResponse.json({ ...result, fid, action });
          }

          // Plain data edit — just repoints the sponsor relationship, no
          // payout. Use this to fix a wrong sponsor on a real user without
          // re-paying them.
          await kv.set(`refbase:${walletAddr}`, referrerAddr);
          const referredBase = (await kv.get<string[]>(`referrerbase:${referrerAddr}:referred`)) ?? [];
          if (!referredBase.includes(walletAddr!)) {
            await kv.set(`referrerbase:${referrerAddr}:referred`, [...referredBase, walletAddr]);
          }
          return NextResponse.json({ ok: true, fid, action, newReferrerFid: `wallet:${referrerAddr}` });
        }

        // triggerPayout=true runs the SAME registerReferral() flow a real
        // ?ref=<fid> link click triggers — KV writes, wallet lookup via
        // Neynar, and an actual sendDegen payout with attribution. This
        // exists so a manually-added test fid can be verified end-to-end
        // (real DEGEN, real tx hash) without needing a second device/wallet
        // to click a real referral link. It will reject the same way a real
        // join would (self-referral, already registered, existing activity)
        // — use "Remove Sponsor" first if you need to re-test a fid.
        if (triggerPayout) {
          const result = await registerReferral(Number(fid), Number(newReferrerFid));
          return NextResponse.json({ ...result, fid, action });
        }

        // Plain data edit — just repoints the sponsor relationship, no
        // payout. Use this to fix a wrong sponsor on a real user without
        // re-paying them.
        await kv.set(`ref:${fid}`, String(newReferrerFid));
        const referred = (await kv.get<number[]>(`referrer:${newReferrerFid}:referred`)) ?? [];
        if (!referred.includes(Number(fid))) {
          await kv.set(`referrer:${newReferrerFid}:referred`, [...referred, Number(fid)]);
        }
        return NextResponse.json({ ok: true, fid, action, newReferrerFid });
      }

      return NextResponse.json({ ok: false, reason: "provide newReferrerFid or removeReferral:true" }, { status: 400 });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/user-control] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
