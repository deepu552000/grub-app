// app/api/minigames/cointoss/route.ts
//
//   GET  /api/minigames/cointoss?fid=<fid>&wallet=<wallet>
//        Returns the public game config (min/max bet, fee), the caller's
//        internal balance, a recent-flips feed (anonymized), and the
//        caller's own last-5 cash-outs + last-5 deposits (myCashouts /
//        myDeposits) so the outcome is auditable in aggregate even without
//        a provably-fair scheme — see lib/minigames.ts's file header.
//
//   POST /api/minigames/cointoss
//        Body: { fid?, wallet?, action, betDegen?, choice?, amountDegen?, cashoutWallet?, txHash? }
//        action = "flip" | "cashout" | "deposit"
//        flip needs betDegen + choice ("heads"|"tails")
//        cashout needs amountDegen + cashoutWallet (where to send real DEGEN)
//        deposit needs txHash + amountDegen (on-chain DEGEN sent to treasury)

import { NextRequest, NextResponse } from "next/server";
import { petKey } from "@/lib/pet-key";
import {
  getCoinTossConfig,
  getBalance,
  getRecentFlips,
  placeCoinTossBet,
  requestCashout,
  getCashoutsForIdentity,
  depositDegen,
  getDepositsForIdentity,
} from "@/lib/minigames";

export async function GET(req: NextRequest) {
  try {
    const fid = req.nextUrl.searchParams.get("fid");
    const wallet = req.nextUrl.searchParams.get("wallet");
    const key = petKey(fid, wallet);

    const config = await getCoinTossConfig();
    const balance = key ? await getBalance(key) : 0;

    // The caller's own withdrawal history (pending + recently fulfilled) —
    // this is the missing piece that was letting a queued cash-out vanish
    // from the UI the moment the toast disappeared, with no way to see it
    // land once an admin fulfilled it from the dashboard. Safe to return
    // in full for this identity: it's the player's own data, keyed to the
    // same fid/wallet they just sent us.
    const myCashouts = key
      ? (await getCashoutsForIdentity(key, 5)).map((c) => ({
          id: c.id,
          amountDegen: c.amountDegen,
          status: c.status,
          txHash: c.txHash,
          requestedAt: c.requestedAt,
          fulfilledAt: c.fulfilledAt,
        }))
      : [];

    // Same idea, for on-chain deposits — the counterpart list to
    // myCashouts above, so the UI can show "last 5 deposits" the same way
    // it shows "last 5 cash-outs".
    const myDeposits = key
      ? (await getDepositsForIdentity(key, 5)).map((d) => ({
          id: d.id,
          amountDegen: d.amountDegen,
          txHash: d.txHash,
          ts: d.ts,
        }))
      : [];

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
      myCashouts,
      myDeposits,
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
        return NextResponse.json({ ...result, ok: false }, { status: 400 });
      }
      return NextResponse.json({ ...result, ok: true });
    }

    if (action === "cashout") {
      const { amountDegen, cashoutWallet } = body;
      if (!cashoutWallet || typeof cashoutWallet !== "string") {
        return NextResponse.json({ ok: false, reason: "missing cashoutWallet" }, { status: 400 });
      }
      const result = await requestCashout(key, Number(amountDegen), cashoutWallet);
      if (!result.ok) {
        return NextResponse.json({ ...result, ok: false }, { status: 400 });
      }
      return NextResponse.json({ ...result, ok: true });
    }

    // ── On-chain DEGEN deposit — player already sent the tx client-side
    // (sendDegenDeposit in Client.tsx); we just verify it landed at the
    // treasury and credit the same balance flip/cashout use ─────────────────
    if (action === "deposit") {
      const { txHash, amountDegen } = body;
      if (!txHash || typeof txHash !== "string") {
        return NextResponse.json({ ok: false, reason: "missing txHash" }, { status: 400 });
      }
      const result = await depositDegen(key, txHash, Number(amountDegen));
      if (!result.ok) {
        return NextResponse.json({ ...result, ok: false }, { status: 400 });
      }
      return NextResponse.json({ ...result, ok: true });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[minigames/cointoss] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
