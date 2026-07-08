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
import {
  getCoinTossConfig,
  setCoinTossConfig,
  getCoinTossStats,
  getAlerts,
  getPendingCashouts,
  fulfillCashout,
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
    const [config, stats, alerts, pendingCashouts] = await Promise.all([
      getCoinTossConfig(),
      getCoinTossStats(),
      getAlerts(),
      getPendingCashouts(),
    ]);
    return NextResponse.json({ ok: true, config, stats, alerts, pendingCashouts });
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

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/minigames] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
