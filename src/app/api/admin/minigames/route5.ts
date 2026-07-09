// app/api/admin/minigames/route.ts
//
//   GET  /api/admin/minigames
//        Returns Coin Toss config, live stats (all-time + rolling 24h),
//        recent auto-pause alerts, and the pending cash-out queue.
//
//   POST /api/admin/minigames
//        Body: { action, ...fields }
//        action = "update_config" | "toggle_enabled" | "fulfill_cashout"
//        update_config takes any subset of CoinTossConfig fields.
//        fulfill_cashout takes { cashoutId }.
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
  getPendingCashouts,
  fulfillCashout,
  cancelCashout,
  creditBalance,
  cancelCredit,
  getBalance,
  getCreditHistory,
  type CoinTossConfig,
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
    const [config, stats, alerts, pendingCashouts, creditHistory] = await Promise.all([
      getCoinTossConfig(),
      getCoinTossStats(),
      getAlerts(),
      getPendingCashouts(),
      getCreditHistory(50),
    ]);
    return NextResponse.json({ ok: true, config, stats, alerts, pendingCashouts, creditHistory });
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
];

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { action } = body;

    // ── Update any subset of the config — this is how min/max bet, fee %,
    // circuit-breaker threshold etc. all get tuned without a redeploy ──────
    if (action === "update_config") {
      const patch: Partial<CoinTossConfig> = {};
      for (const k of CONFIG_KEYS) {
        if (body[k] !== undefined) (patch as any)[k] = body[k];
      }
      const updated = await setCoinTossConfig(patch);
      return NextResponse.json({ ok: true, action, config: updated });
    }

    // ── Quick pause/resume toggle — same effect as update_config with
    // {enabled}, kept as its own action for a single-click dashboard button ─
    if (action === "toggle_enabled") {
      const current = await getCoinTossConfig();
      const updated = await setCoinTossConfig({ enabled: !current.enabled });
      return NextResponse.json({ ok: true, action, enabled: updated.enabled });
    }

    // ── Send a queued cash-out (anything over autoCashoutMaxDegen, or an
    // auto-send that failed and fell back to the queue) ────────────────────
    if (action === "fulfill_cashout") {
      const { cashoutId } = body;
      if (!cashoutId) {
        return NextResponse.json({ ok: false, reason: "missing cashoutId" }, { status: 400 });
      }
      const result = await fulfillCashout(cashoutId);
      return NextResponse.json({ action, cashoutId, ...result });
    }

    // ── Cancel a still-pending cash-out — refunds the internal balance
    // instead of sending it, for when a request was a mistake or the
    // player wants to keep gambling instead of withdrawing ────────────────
    if (action === "cancel_cashout") {
      const { cashoutId } = body;
      if (!cashoutId) {
        return NextResponse.json({ ok: false, reason: "missing cashoutId" }, { status: 400 });
      }
      const result = await cancelCashout(cashoutId);
      return NextResponse.json({ action, cashoutId, ...result });
    }

    // ── Manually credit a player's internal DEGEN balance — the admin-side
    // top-up path. Same underlying creditBalance() that an on-chain deposit
    // flow will call later once that's built; for now this is the only way
    // DEGEN gets into a player's balance short of winning a flip ────────────
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

    // ── Reverse a manual top-up — pulls the credited amount back out of the
    // player's internal balance and marks the log entry cancelled, for when
    // an admin credit was a mistake (wrong amount, wrong player, etc.) ──────
    if (action === "cancel_credit") {
      const { creditId } = body;
      if (!creditId) {
        return NextResponse.json({ ok: false, reason: "missing creditId" }, { status: 400 });
      }
      const result = await cancelCredit(creditId);
      return NextResponse.json({ action, creditId, ...result });
    }

    // ── Look up a player's current internal balance by fid/wallet — lets
    // the admin dashboard confirm a credit landed before/without a full
    // page reload of the whole mini-games panel ────────────────────────────
    if (action === "lookup_balance") {
      const { fid, wallet } = body;
      const key = petKey(fid ?? null, wallet ?? null);
      if (!key) {
        return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
      }
      const balance = await getBalance(key);
      return NextResponse.json({ ok: true, action, identityKey: key, balance });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/minigames] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
