// app/api/minigames/cointoss/route.ts
//
//   GET  /api/minigames/cointoss?fid=<fid>&wallet=<wallet>
//        Returns the public game config (min/max bet, fee), the caller's
//        internal balance, and a recent-flips feed (anonymized) so the
//        outcome is auditable in aggregate even without a provably-fair
//        scheme — see lib/minigames.ts's file header.
//
//   POST /api/minigames/cointoss
//        Body: { fid?, wallet?, action, betDegen?, choice?, amountDegen?, cashoutWallet? }
//        action = "flip" | "cashout"
//        flip needs betDegen + choice ("heads"|"tails")
//        cashout needs amountDegen + cashoutWallet (where to send real DEGEN)

import { NextRequest, NextResponse } from "next/server";
import { petKey } from "@/lib/pet-key";
import {
  getCoinTossConfig,
  getBalance,
  getRecentFlips,
  placeCoinTossBet,
  requestCashout,
} from "@/lib/minigames";

export async function GET(req: NextRequest) {
  try {
    const fid = req.nextUrl.searchParams.get("fid");
    const wallet = req.nextUrl.searchParams.get("wallet");
    const key = petKey(fid, wallet);

    const config = await getCoinTossConfig();
    const balance = key ? await getBalance(key) : 0;

    // Anonymized feed — identityKey never leaves the server, same care
    // taken with raffle winners via publicWinnerLabel().
    const recent = (await getRecentFlips(20)).map((f) => ({
      choice: f.choice,
      result: f.result,
      won: f.won,
      betDegen: f.betDegen,
      payoutDegen: f.payoutDegen,
      ts: f.ts,
    }));

    return NextResponse.json({
      ok: true,
      config: {
        enabled: config.enabled,
        minBetDegen: config.minBetDegen,
        maxBetDegen: config.maxBetDegen,
        feePercentOnWin: config.feePercentOnWin,
      },
      balance,
      recentFlips: recent,
    });
  } catch (err: any) {
    console.error("[minigames/cointoss] GET error:", err);
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

    if (action === "flip") {
      const { betDegen, choice } = body;
      const result = await placeCoinTossBet(key, Number(betDegen), choice);
      if (!result.ok) {
        return NextResponse.json({ ok: false, reason: result.reason }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "cashout") {
      const { amountDegen, cashoutWallet } = body;
      if (!cashoutWallet || typeof cashoutWallet !== "string") {
        return NextResponse.json({ ok: false, reason: "missing cashoutWallet" }, { status: 400 });
      }
      const result = await requestCashout(key, Number(amountDegen), cashoutWallet);
      if (!result.ok) {
        return NextResponse.json({ ok: false, reason: result.reason }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...result });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[minigames/cointoss] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
