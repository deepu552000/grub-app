// app/api/admin/minigames/route.ts
//
//   GET  /api/admin/minigames
//        Returns Coin Toss config/stats/alerts/cash-outs (unchanged) PLUS
//        Dice config, live stats (all-time + rolling 24h), recent alerts,
//        recent rolls, player stats, and provably-fair seed info — Dice
//        shares the Coin Toss cash-out queue (same underlying balance),
//        so there's no separate dice cash-out list.
//
//   POST /api/admin/minigames
//        Body: { action, ...fields }
//        Existing Coin Toss actions unchanged. New Dice actions:
//          "update_dice_config" | "toggle_dice_enabled" |
//          "purge_dice_roll_history" | "rotate_dice_seed"
//
// Auth follows the same Clerk-session pattern as /api/admin/raffle.

import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@clerk/nextjs/server";
import { petKey } from "@/lib/pet-key";
import {
  getCoinTossConfig,
  setCoinTossConfig,
  getCoinTossStats,
  getAlerts,
  getRecentCashouts,
  fulfillCashout,
  cancelCashout,
  creditBalance,
  cancelCredit,
  getBalance,
  getCreditHistory,
  getRecentFlips,
  getFlipsForIdentity,
  getActiveSeedSummary,
  getSeedHistory,
  rotateServerSeed,
  getAllCoinTossPlayerStats,
  backfillCoinTossTotals,
  purgeCoinTossFlipHistory,
  type CoinTossConfig,
  // ── Dice ──────────────────────────────────────────────────────────────
  getDiceConfig,
  setDiceConfig,
  getDiceStats,
  getDiceAlerts,
  getRecentDiceRolls,
  getDiceRollsForIdentity,
  getDiceActiveSeedSummary,
  getDiceSeedHistory,
  rotateDiceServerSeed,
  getAllDicePlayerStats,
  purgeDiceRollHistory,
  type DiceConfig,
} from "@/lib/minigames";

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

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) return unauthorized();

  try {
    const [
      config,
      stats,
      alerts,
      recentCashouts,
      creditHistory,
      recentFlips,
      activeSeed,
      seedHistory,
      playerStats,
      // ── Dice ──
      diceConfig,
      diceStats,
      diceAlerts,
      recentDiceRolls,
      diceActiveSeed,
      diceSeedHistory,
      dicePlayerStats,
    ] = await Promise.all([
      getCoinTossConfig(),
      getCoinTossStats(),
      getAlerts(),
      getRecentCashouts(20),
      getCreditHistory(50),
      getRecentFlips(100),
      getActiveSeedSummary(),
      getSeedHistory(20),
      getAllCoinTossPlayerStats(),
      // ── Dice ──
      getDiceConfig(),
      getDiceStats(),
      getDiceAlerts(),
      getRecentDiceRolls(100),
      getDiceActiveSeedSummary(),
      getDiceSeedHistory(20),
      getAllDicePlayerStats(),
    ]);
    return NextResponse.json({
      ok: true,
      config,
      stats,
      alerts,
      recentCashouts,
      creditHistory,
      recentFlips,
      activeSeed,
      seedHistory,
      playerStats,
      // ── Dice ──
      diceConfig,
      diceStats,
      diceAlerts,
      recentDiceRolls,
      diceActiveSeed,
      diceSeedHistory,
      dicePlayerStats,
    });
  } catch (err: any) {
    console.error("[admin/minigames] GET error:", err);
    return NextResponse.json({ ok: false, reason: err?.message }, { status: 500 });
  }
}

const CONFIG_KEYS: (keyof CoinTossConfig)[] = [
  "enabled",
  "minBetDegen",
  "maxBetDegen",
  "feePercentOnWin",
  "maxBetPercentOfTreasury",
  "lossCircuitBreakerDegen",
  "maxFlipsPerMinutePerUser",
  "autoCashoutMaxDegen",
  "seedRotateAfterFlips",
];

// ── Dice config keys — mirrors CONFIG_KEYS above, own field list ─────────
const DICE_CONFIG_KEYS: (keyof DiceConfig)[] = [
  "enabled",
  "minBetDegen",
  "maxBetDegen",
  "maxBetPercentOfTreasury",
  "houseEdgePercent",
  "minWinChancePercent",
  "maxWinChancePercent",
  "maxMultiplier",
  "maxPayoutDegen",
  "lossCircuitBreakerDegen",
  "maxRollsPerMinutePerUser",
  "seedRotateAfterRolls",
];

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { action } = body;

    // ── Update any subset of the Coin Toss config ──────────────────────────
    if (action === "update_config") {
      const patch: Partial<CoinTossConfig> = {};
      for (const k of CONFIG_KEYS) {
        if (body[k] !== undefined) (patch as any)[k] = body[k];
      }
      const updated = await setCoinTossConfig(patch);
      return NextResponse.json({ ok: true, action, config: updated });
    }

    // ── Quick pause/resume toggle for Coin Toss ─────────────────────────────
    if (action === "toggle_enabled") {
      const current = await getCoinTossConfig();
      const updated = await setCoinTossConfig({ enabled: !current.enabled });
      return NextResponse.json({ ok: true, action, enabled: updated.enabled });
    }

    // ── Update any subset of the Dice config — same "tune without a
    // redeploy" idea as Coin Toss's update_config above ─────────────────────
    if (action === "update_dice_config") {
      const patch: Partial<DiceConfig> = {};
      for (const k of DICE_CONFIG_KEYS) {
        if (body[k] !== undefined) (patch as any)[k] = body[k];
      }
      const updated = await setDiceConfig(patch);
      return NextResponse.json({ ok: true, action, diceConfig: updated });
    }

    // ── Quick pause/resume toggle for Dice — independent of Coin Toss's ────
    if (action === "toggle_dice_enabled") {
      const current = await getDiceConfig();
      const updated = await setDiceConfig({ enabled: !current.enabled });
      return NextResponse.json({ ok: true, action, enabled: updated.enabled });
    }

    // ── Send a queued cash-out ───────────────────────────────────────────────
    if (action === "fulfill_cashout") {
      const { cashoutId } = body;
      if (!cashoutId) {
        return NextResponse.json({ ok: false, reason: "missing cashoutId" }, { status: 400 });
      }
      const result = await fulfillCashout(cashoutId);
      return NextResponse.json({ action, cashoutId, ...result });
    }

    // ── Cancel a still-pending cash-out ──────────────────────────────────────
    if (action === "cancel_cashout") {
      const { cashoutId } = body;
      if (!cashoutId) {
        return NextResponse.json({ ok: false, reason: "missing cashoutId" }, { status: 400 });
      }
      const result = await cancelCashout(cashoutId);
      return NextResponse.json({ action, cashoutId, ...result });
    }

    // ── Manually credit a player's internal DEGEN balance ───────────────────
    if (action === "credit_balance") {
      const { fid, wallet, amountDegen, reason } = body;
      const key = petKey(fid ?? null, wallet ?? null);
      if (!key) {
        return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
      }
      const amount = Number(amountDegen);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ ok: false, reason: "invalid amount" }, { status: 400 });
      }
      const newBalance = await creditBalance(key, amount, reason?.trim() || "manual admin top-up");
      return NextResponse.json({ ok: true, action, identityKey: key, newBalance });
    }

    // ── Reverse a manual top-up ───────────────────────────────────────────────
    if (action === "cancel_credit") {
      const { creditId } = body;
      if (!creditId) {
        return NextResponse.json({ ok: false, reason: "missing creditId" }, { status: 400 });
      }
      const result = await cancelCredit(creditId);
      return NextResponse.json({ action, creditId, ...result });
    }

    // ── Look up a player's current internal balance by fid/wallet ──────────
    if (action === "lookup_balance") {
      const { fid, wallet } = body;
      const key = petKey(fid ?? null, wallet ?? null);
      if (!key) {
        return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
      }
      const balance = await getBalance(key);
      return NextResponse.json({ ok: true, action, identityKey: key, balance });
    }

    // ── On-demand lookup of one player's full Coin Toss flip history ───────
    if (action === "lookup_flip_history") {
      const { fid, wallet } = body;
      const key = petKey(fid ?? null, wallet ?? null);
      if (!key) {
        return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
      }
      const flips = await getFlipsForIdentity(key, 500);
      return NextResponse.json({ ok: true, action, identityKey: key, flips });
    }

    // ── On-demand lookup of one player's full Dice roll history — mirrors
    // lookup_flip_history above, own action name so the UI's Player History
    // search box can look up either game's history for the same identity ────
    if (action === "lookup_dice_history") {
      const { fid, wallet } = body;
      const key = petKey(fid ?? null, wallet ?? null);
      if (!key) {
        return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
      }
      const rolls = await getDiceRollsForIdentity(key, 500);
      return NextResponse.json({ ok: true, action, identityKey: key, rolls });
    }

    // ── Manually rotate the Coin Toss provably-fair server seed ────────────
    if (action === "rotate_seed") {
      const rotated = await rotateServerSeed();
      return NextResponse.json({ ok: true, action, activeSeed: { serverSeedHash: rotated.serverSeedHash, flipsUsed: rotated.nonce, createdAt: rotated.createdAt } });
    }

    // ── Manually rotate the Dice provably-fair server seed — independent
    // seed/cadence from Coin Toss's rotate_seed above ───────────────────────
    if (action === "rotate_dice_seed") {
      const rotated = await rotateDiceServerSeed();
      return NextResponse.json({ ok: true, action, diceActiveSeed: { serverSeedHash: rotated.serverSeedHash, rollsUsed: rotated.nonce, createdAt: rotated.createdAt } });
    }

    // ── One-time migration for Coin Toss totals ─────────────────────────────
    if (action === "backfill_cointoss_totals") {
      const result = await backfillCoinTossTotals();
      return NextResponse.json({ ok: true, action, ...result });
    }

    // ── Clears one identity's Coin Toss win/loss FLIP HISTORY only ─────────
    if (action === "purge_cointoss_flip_history") {
      const { identityKey } = body;
      if (!identityKey || typeof identityKey !== "string") {
        return NextResponse.json({ ok: false, reason: "missing identityKey" }, { status: 400 });
      }
      const result = await purgeCoinTossFlipHistory(identityKey);
      return NextResponse.json({ ok: true, action, identityKey, ...result });
    }

    // ── Clears one identity's Dice win/loss ROLL HISTORY only — mirrors
    // purge_cointoss_flip_history above. Balance, deposits, cash-outs, and
    // credit history are untouched (those are shared across both games) ────
    if (action === "purge_dice_roll_history") {
      const { identityKey } = body;
      if (!identityKey || typeof identityKey !== "string") {
        return NextResponse.json({ ok: false, reason: "missing identityKey" }, { status: 400 });
      }
      const result = await purgeDiceRollHistory(identityKey);
      return NextResponse.json({ ok: true, action, identityKey, ...result });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/minigames] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
