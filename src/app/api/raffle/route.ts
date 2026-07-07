// app/api/raffle/route.ts
//
//   GET  /api/raffle?fid=<fid>&wallet=<wallet>
//        Returns the current open round's public status, plus the caller's
//        own ticket count in it (if fid/wallet given).
//
//   POST /api/raffle
//        Body: { fid?, wallet?, txHash }
//        Verifies a $0.10 USDC payment on-chain, then records one ticket
//        for the caller in the currently open round. Same
//        verify-then-replay-guard shape as /api/pet's checkin/unlock_accessory/
//        wheel_spin — see that file's comments for why the ordering
//        (verify → write → THEN mark txHash used) matters.
//
// NOTE: verifyUsdcTransfer here is intentionally a self-contained copy of
// the one in app/api/pet/route.ts rather than a shared import. That file is
// small, stable, and has already been hardened through several real
// incidents — duplicating ~50 lines here avoids touching it at all for an
// unrelated feature. If you ever change the verification logic, remember
// there are two copies (this one and pet/route.ts's).

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { petKey, identityLabel } from "@/lib/pet-key";
import {
  ensureOpenRound,
  getOpenRound,
  getTicketCount,
  getLiveTicketTotal,
  recordTicketPurchase,
  MAX_TICKETS_PER_USER_PER_ROUND,
  TICKET_PRICE_MICRO_USDC,
} from "@/lib/raffle";

const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0xCF8A44059652DB5Af8B4CB62938c5DC6916eB082";
const BASE_RPC = "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function verifyUsdcTransfer(
  txHash: string,
  expectedMicroUsdc: number,
): Promise<{ ok: boolean; error?: string }> {
  const recipientTopic = "0x000000000000000000000000" + RECIPIENT.replace(/^0x/, "").toLowerCase();
  const expectedHex = "0x" + expectedMicroUsdc.toString(16).padStart(64, "0");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      });
      const json = await res.json();

      if (json?.error) {
        console.error(`[raffle] Base RPC error: ${JSON.stringify(json.error)}`);
        return { ok: false, error: `Payment verification failed (RPC error: ${json.error.message ?? "unknown"}).` };
      }

      const logs: any[] = json?.result?.logs ?? [];
      const match = logs.find(
        (l) =>
          l.address?.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
          l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.topics?.[2]?.toLowerCase() === recipientTopic &&
          l.data?.toLowerCase() === expectedHex.toLowerCase(),
      );
      if (match) return { ok: true };
      if (json?.result && logs.length > 0) {
        return { ok: false, error: "USDC transfer to Grub not found in transaction." };
      }
    } catch {
      // network blip — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { ok: false, error: "Transaction not confirmed within 30s. Try again." };
}

// ── GET — current round status + caller's ticket count ──────────────────────
export async function GET(req: NextRequest) {
  const fid = req.nextUrl.searchParams.get("fid");
  const wallet = req.nextUrl.searchParams.get("wallet");

  try {
    const round = (await getOpenRound()) ?? (await ensureOpenRound());
    const roundTotal = await getLiveTicketTotal(round.id);

    let myTickets = 0;
    const key = petKey(fid, wallet);
    if (key) myTickets = await getTicketCount(round.id, key);

    return NextResponse.json({
      ok: true,
      round: {
        id: round.id,
        status: round.status,
        ticketPriceMicroUsdc: round.ticketPriceMicroUsdc,
        openedAt: round.openedAt,
        locksAt: round.locksAt,
        ticketCount: roundTotal,
      },
      myTickets,
      maxTicketsPerUser: MAX_TICKETS_PER_USER_PER_ROUND,
    });
  } catch (err: any) {
    console.error("[raffle] GET error:", err);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

// ── POST — buy one ticket ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, wallet, txHash } = body;

    const key = petKey(fid, wallet);
    const who = identityLabel(fid, wallet);
    if (!key) {
      return NextResponse.json({ ok: false, error: "missing fid or wallet" }, { status: 400 });
    }
    if (!txHash || typeof txHash !== "string") {
      return NextResponse.json({ ok: false, error: "buy_ticket requires txHash" }, { status: 400 });
    }

    // Ban check — same flag /api/pet respects, so a suspended account can't
    // route around a write-block by buying raffle tickets instead.
    const petState = await kv.get<any>(key);
    if (petState?.banned) {
      return NextResponse.json({ ok: false, error: "This account has been suspended." }, { status: 403 });
    }

    const round = (await getOpenRound()) ?? (await ensureOpenRound());
    if (round.status !== "open") {
      return NextResponse.json({ ok: false, error: "Raffle isn't open for entries right now." }, { status: 409 });
    }

    // Check the cap BEFORE burning 30s on payment verification — no point
    // making someone wait for a receipt poll just to reject them anyway.
    const before = await getTicketCount(round.id, key);
    if (before >= MAX_TICKETS_PER_USER_PER_ROUND) {
      return NextResponse.json(
        { ok: false, error: `You already have the max ${MAX_TICKETS_PER_USER_PER_ROUND} tickets for this round.` },
        { status: 409 },
      );
    }

    // Replay attack prevention — same keyspace /api/pet uses for its own
    // paid actions, so a txHash used for a raffle ticket can never also be
    // replayed against checkin/unlock/spin, or vice versa.
    const usedKey = `grub:used-tx:${txHash}`;
    const alreadyUsed = await kv.get(usedKey);
    if (alreadyUsed) {
      return NextResponse.json({ ok: false, error: "This transaction has already been used." }, { status: 400 });
    }

    const verify = await verifyUsdcTransfer(txHash, TICKET_PRICE_MICRO_USDC);
    if (!verify.ok) {
      return NextResponse.json({ ok: false, error: verify.error }, { status: 402 });
    }

    const result = await recordTicketPurchase(round, key);
    if (!result) {
      // Only reachable via a genuine race (two concurrent buys from the
      // same identity both passing the pre-check above) — the payment DID
      // clear, so this is a real edge case worth a clear message rather
      // than a silent 409, since money moved but no ticket was granted.
      return NextResponse.json(
        {
          ok: false,
          error: `Payment confirmed, but you're already at the ${MAX_TICKETS_PER_USER_PER_ROUND}-ticket cap for this round — contact support with this tx hash for a refund.`,
          txHash,
        },
        { status: 409 },
      );
    }

    // Mark used only after the ticket write succeeded — same reasoning as
    // every paid action in /api/pet: a failed write can still be retried
    // with the same txHash, a successful one can't be replayed.
    await kv.set(usedKey, { fid: fid ?? null, wallet: wallet ?? null, purpose: "raffle_ticket", roundId: round.id, ts: Date.now() }, { ex: 60 * 60 * 24 * 365 });

    console.log(`[raffle] ✅ ticket sold ${who} round=${round.id} newCount=${result.newCount} tx=${txHash}`);
    return NextResponse.json({
      ok: true,
      myTickets: result.newCount,
      roundTotal: result.roundTotal,
    });
  } catch (err: any) {
    console.error("[raffle] POST error:", err);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
