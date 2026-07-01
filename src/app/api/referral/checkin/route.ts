// app/api/referral/checkin/route.ts
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendDegen, recordFailedPayout, acquireLock, releaseLock } from "@/lib/referral";

async function logDegenTxn(entry: {
  fid: number;
  toFid: number;
  type: "referral_join" | "referral_checkin";
  txHash: string;
  amountDegen: number;
  toWallet: string;
}) {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "https://grub-app-eight.vercel.app"}/api/txn-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fid: entry.fid,
        type: entry.type,
        txHash: entry.txHash,
        amountUsd: 0,
        amountDegen: entry.amountDegen,
        toFid: entry.toFid,
        toWallet: entry.toWallet,
        ts: Date.now(),
      }),
    });
  } catch { /* non-blocking */ }
}

export async function POST(req: NextRequest) {
  try {
    const { userFID } = await req.json();

    if (!userFID) {
      return NextResponse.json({ ok: false, reason: "missing fid" }, { status: 400 });
    }

    const referrerFID = await kv.get(`ref:${userFID}`);
    if (!referrerFID) {
      return NextResponse.json({ ok: false, reason: "not a referred user" });
    }

    const status = await kv.get(`ref:${userFID}:status`);
    if (status === "paid") {
      return NextResponse.json({ ok: false, reason: "already paid" });
    }

    const count = await kv.incr(`ref:${userFID}:checkins`);
    console.log(`[referral/checkin] FID ${userFID} checkin count: ${count}`);

    if (count < 5) {
      return NextResponse.json({ ok: true, checkins: count, paid: false });
    }

    const wallet = await kv.get<string>(`ref:${referrerFID}:wallet`);
    if (!wallet) {
      return NextResponse.json({ ok: false, reason: "referrer wallet not found" });
    }

    // Lock so a manual dashboard retry can't race this same payout —
    // whoever gets here first blocks the other until done (or 30s TTL expires
    // as a safety net if this request crashes mid-payment).
    const lockKey = `ref:${userFID}:paylock`;
    const gotLock = await acquireLock(lockKey, 30);
    if (!gotLock) {
      console.warn(`[referral/checkin] payout for FID ${userFID} already in progress, skipping duplicate attempt`);
      return NextResponse.json({
        ok: true,
        checkins: count,
        paid: false,
        reason: "payout already in progress elsewhere — try again shortly",
      });
    }

    try {
      let txHash: string;
      try {
        txHash = await sendDegen(wallet, 2);
      } catch (err: any) {
        console.error("[referral/checkin] sendDegen failed:", err);
        await recordFailedPayout({
          fid: Number(referrerFID),
          toFid: Number(userFID),
          toWallet: wallet,
          amountDegen: 2,
          type: "referral_checkin",
          reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error",
          broadcastTxHash: err?.broadcastTxHash ?? null,
          // status stays "joined" on failure, so a retry can still mark it paid
          sideEffect: { kvKey: `ref:${userFID}:status`, kvValue: "paid" },
        });
        return NextResponse.json({
          ok: false,
          reason: "DEGEN payout failed — logged for retry in dashboard",
          checkins: count,
          paid: false,
        });
      }

      await kv.set(`ref:${userFID}:status`, "paid");

      // Log the DEGEN payout
      await logDegenTxn({
        fid: Number(referrerFID),
        toFid: Number(userFID),
        type: "referral_checkin",
        txHash,
        amountDegen: 2,
        toWallet: wallet,
      });

      console.log(`[referral/checkin] paid 2 DEGEN to ${wallet} for referring FID ${userFID}`);
      return NextResponse.json({ ok: true, checkins: count, paid: true, txHash });
    } finally {
      await releaseLock(lockKey);
    }
  } catch (err: any) {
    console.error("[referral/checkin] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
