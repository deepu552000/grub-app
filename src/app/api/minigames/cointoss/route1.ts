// app/api/minigames/cointoss/route.ts
//
//   GET  /api/minigames/cointoss?fid=<fid>&wallet=<wallet>
//        Returns the public game config (min/max bet, fee), the caller's
//        internal balance, the caller's OWN recent-flips history, and the
//        caller's own last-5 cash-outs + last-5 deposits (myCashouts /
//        myDeposits). recentFlips was previously the shared, all-players
//        feed with no identity filter — every user saw the exact same
//        strip of results regardless of who placed them. Fixed to filter
//        by identity, same as myCashouts/myDeposits already did.
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
  getFlipsForIdentity,
  placeCoinTossBet,
  requestCashout,
  getCashoutsForIdentity,
  depositDegen,
  getDepositsForIdentity,
  getActiveSeedSummary,
  getSeedHistory,
  getOrCreateClientSeed,
} from "@/lib/minigames";

// Format check only (no checksum, no on-chain existence check) — 0x
// followed by exactly 40 hex chars. This is what was missing when a manual
// cash-out went through with cashoutWallet: "50": nothing here or in
// lib/minigames.ts's requestCashout() rejected a non-address string, so it
// sailed straight into the admin fulfillment queue and had to be caught and
// fixed by hand. Mirrors the same check added client-side in Client.tsx —
// this one is the version that actually matters, since it's the one no
// caller (UI, stale build, direct POST) can bypass.
function isValidBaseAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

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

    // THE FIX — this used to be getRecentFlips(20), the shared list of
    // every player's flips with no identity filter, so every single caller
    // got back the exact same array regardless of who they were. Now
    // scoped to this identityKey, same as myCashouts/myDeposits above.
    // Empty for a brand-new player with no flips yet — that's correct,
    // not a bug (they just haven't played).
    //
    // serverSeedHash/nonce/clientSeed are included per-flip (not just on
    // the moment-of-flip response) so the Provably Fair panel's flip list
    // and Verify button work purely off this GET — no extra round trip,
    // and it still works after a page refresh, not just right after a bet.
    const recent = key
      ? (await getFlipsForIdentity(key, 20)).map((f) => ({
          choice: f.choice,
          result: f.result,
          won: f.won,
          betDegen: f.betDegen,
          payoutDegen: f.payoutDegen,
          ts: f.ts,
          serverSeedHash: f.serverSeedHash,
          nonce: f.nonce,
          clientSeed: f.clientSeed,
        }))
      : [];

    // ── Provably-fair data for the player-facing "Provably Fair" panel ──
    // activeSeed: the LIVE seed's public hash + how many flips it's backed
    // so far — never the raw seed while it's still active (see
    // lib/minigames.ts's commit-reveal scheme).
    // seedHistory: seeds that have already rotated out, raw value included
    // — safe once retired, since nothing will ever resolve against them
    // again. This is what actually lets a player verify a past flip: pair
    // a revealed seed's raw value with one of their own flips that shares
    // its serverSeedHash.
    // myClientSeed: this player's own persisted client seed (see
    // getOrCreateClientSeed) — generated once on their first flip, reused
    // since. Read-only for now; no regenerate control yet.
    const activeSeed = await getActiveSeedSummary();
    const seedHistory = await getSeedHistory(20);
    const myClientSeed = key ? await getOrCreateClientSeed(key) : null;

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
      activeSeed,
      seedHistory,
      myClientSeed,
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
      const trimmedWallet = cashoutWallet.trim();
      if (!isValidBaseAddress(trimmedWallet)) {
        return NextResponse.json(
          { ok: false, reason: "cashoutWallet must be a valid Base wallet address (0x followed by 40 hex characters)." },
          { status: 400 },
        );
      }
      const result = await requestCashout(key, Number(amountDegen), trimmedWallet);
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
