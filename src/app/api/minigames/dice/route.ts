// app/api/minigames/dice/route.ts
//
//   GET  /api/minigames/dice?fid=<fid>&wallet=<wallet>
//        Returns the public Dice config (bet limits, house edge, win-chance
//        range, multiplier/payout caps), the caller's internal balance
//        (SAME balance as Coin Toss — shared across games), the caller's
//        own recent rolls, and provably-fair seed info for Dice specifically
//        (own seed/rotation cadence, separate from Coin Toss's).
//
//        Deliberately does NOT re-return myCashouts/myDeposits/myClientSeed —
//        those are shared with Coin Toss and already served by
//        GET /api/minigames/cointoss. The client only needs to fetch this
//        route for what's actually Dice-specific.
//
//   POST /api/minigames/dice
//        Body: { fid?, wallet?, action, betDegen?, target?, direction? }
//        action = "roll"
//        roll needs betDegen + target (2–98) + direction ("under"|"over")
//
// Cash-outs/deposits for Dice winnings go through the EXISTING
// /api/minigames/cointoss cashout/deposit actions — same internal balance,
// no separate Dice wallet or Dice-specific cash-out flow needed.

import { NextRequest, NextResponse } from "next/server";
import { petKey } from "@/lib/pet-key";
import {
  getDiceConfig,
  getBalance,
  getDiceRollsForIdentity,
  placeDiceBet,
  getDiceActiveSeedSummary,
  getDiceSeedHistory,
} from "@/lib/minigames";

export async function GET(req: NextRequest) {
  try {
    const fid = req.nextUrl.searchParams.get("fid");
    const wallet = req.nextUrl.searchParams.get("wallet");
    const key = petKey(fid, wallet);

    const config = await getDiceConfig();
    const balance = key ? await getBalance(key) : 0; // shared with Coin Toss

    const recent = key
      ? (await getDiceRollsForIdentity(key, 20)).map((r) => ({
          target: r.target,
          direction: r.direction,
          roll: r.roll,
          won: r.won,
          winChancePercent: r.winChancePercent,
          multiplier: r.multiplier,
          betDegen: r.betDegen,
          payoutDegen: r.payoutDegen,
          ts: r.ts,
          serverSeedHash: r.serverSeedHash,
          nonce: r.nonce,
          clientSeed: r.clientSeed,
        }))
      : [];

    const activeSeed = await getDiceActiveSeedSummary();
    const seedHistory = await getDiceSeedHistory(20);

    return NextResponse.json({
      ok: true,
      config: {
        enabled: config.enabled,
        minBetDegen: config.minBetDegen,
        maxBetDegen: config.maxBetDegen,
        houseEdgePercent: config.houseEdgePercent,
        minWinChancePercent: config.minWinChancePercent,
        maxWinChancePercent: config.maxWinChancePercent,
        maxMultiplier: config.maxMultiplier,
        maxPayoutDegen: config.maxPayoutDegen,
      },
      balance,
      recentRolls: recent,
      activeSeed,
      seedHistory,
    });
  } catch (err: any) {
    console.error("[minigames/dice] GET error:", err);
    return NextResponse.json({ ok: false, reason: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, wallet, action } = body;
    const key = petKey(fid, wallet);
    if (!key) {
      return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
    }

    if (action === "roll") {
      const { betDegen, target, direction } = body;
      const result = await placeDiceBet(key, Number(betDegen), Number(target), direction);
      if (!result.ok) {
        return NextResponse.json({ ...result, ok: false }, { status: 400 });
      }
      return NextResponse.json({ ...result, ok: true });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[minigames/dice] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
