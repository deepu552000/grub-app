// app/api/admin/failed-payouts/route.ts
//
// GET  /api/admin/failed-payouts
//        Lists every DEGEN payout that failed to send (e.g. treasury wallet
//        ran dry). Newest first.
//
// POST /api/admin/failed-payouts
//        Body: { id, action: "retry" | "dismiss" }
//        retry   — re-attempts sendDegen for that record. On success, removes
//                  it from the failed list, logs the txn to /api/txn-log, and
//                  applies any pending side-effect (e.g. marking a referral
//                  checkin as "paid" — that write was skipped on the original
//                  failed attempt).
//        dismiss — removes the record without paying (use if you already
//                  paid it manually from your own wallet).

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";
import { sendDegen, acquireLock, releaseLock, type FailedPayout } from "@/lib/referral";

const FAILED_PAYOUTS_KEY = "failed-payouts";

async function requireAuth(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    return true;
  } catch {
    return false;
  }
}

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

export async function GET(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const list = (await kv.get<FailedPayout[]>(FAILED_PAYOUTS_KEY)) ?? [];
    return NextResponse.json({ ok: true, count: list.length, payouts: list.slice().reverse() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id, action, confirmed, txHash } = await req.json();
    if (!id || !action) {
      return NextResponse.json({ ok: false, reason: "missing id or action" }, { status: 400 });
    }

    const list = (await kv.get<FailedPayout[]>(FAILED_PAYOUTS_KEY)) ?? [];
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) {
      return NextResponse.json({ ok: false, reason: "payout record not found (already resolved?)" }, { status: 404 });
    }
    const record = list[idx];

    if (action === "dismiss") {
      // If the admin has verified (on Basescan, or via manual payment) that
      // this DEGEN actually moved, they can pass the real txHash here so the
      // dismiss backfills the txn log instead of silently losing the record.
      // Without this, a payout that was ACTUALLY successful but got marked
      // "failed" (e.g. broadcast-but-unconfirmed, or a pre-fix legacy record
      // with no broadcastTxHash) just vanishes from history on dismiss.
      if (txHash) {
        await logDegenTxn({
          fid: record.fid,
          toFid: record.toFid,
          type: record.type,
          txHash,
          amountDegen: record.amountDegen,
          toWallet: record.toWallet,
        });
        if (record.sideEffect) {
          await kv.set(record.sideEffect.kvKey, record.sideEffect.kvValue);
        }
      }

      list.splice(idx, 1);
      await kv.set(FAILED_PAYOUTS_KEY, list);
      return NextResponse.json({ ok: true, dismissed: record.id, backfilled: !!txHash });
    }

    if (action === "retry") {
      // This record's original attempt was broadcast on-chain but confirming
      // it failed — the DEGEN may already be sitting in the recipient's
      // wallet. Retrying blindly can double-pay. Require the caller to
      // explicitly confirm they checked Basescan first.
      if (record.broadcastTxHash && !confirmed) {
        return NextResponse.json({
          ok: false,
          reason: `This payout was broadcast (tx ${record.broadcastTxHash}) but never confirmed — it may have already been sent. Check Basescan for that hash before retrying.`,
          requiresConfirmation: true,
          broadcastTxHash: record.broadcastTxHash,
        });
      }

      // Same lock keys used by the natural checkin/register flow — this is
      // what actually prevents the double-pay bug: if that fid's own next
      // checkin (or a concurrent register call) is mid-payment right now,
      // this bails out instead of racing it.
      const lockKey = record.type === "referral_checkin"
        ? `ref:${record.toFid}:paylock`
        : `ref:${record.toFid}:joinlock`;

      const gotLock = await acquireLock(lockKey, 30);
      if (!gotLock) {
        return NextResponse.json({
          ok: false,
          reason: "a payout for this fid is already being processed elsewhere (e.g. their own checkin just fired) — wait a few seconds and retry",
        });
      }

      try {
        let txHash: string;
        try {
          txHash = await sendDegen(record.toWallet, record.amountDegen);
        } catch (err: any) {
          // Still failing (e.g. treasury still empty, or another broadcast-
          // but-unconfirmed hiccup) — update reason/hash/timestamp in place
          // so the dashboard shows the latest state, keep it in the list.
          const updatedReason = err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error";
          list[idx] = {
            ...record,
            reason: updatedReason,
            broadcastTxHash: err?.broadcastTxHash ?? null,
            ts: Date.now(),
          };
          await kv.set(FAILED_PAYOUTS_KEY, list);
          return NextResponse.json({
            ok: false,
            reason: "retry failed — still logged",
            detail: updatedReason,
            broadcastTxHash: err?.broadcastTxHash ?? null,
          });
        }

        // Success — remove from failed list, log the txn, apply any side effect
        list.splice(idx, 1);
        await kv.set(FAILED_PAYOUTS_KEY, list);

        await logDegenTxn({
          fid: record.fid,
          toFid: record.toFid,
          type: record.type,
          txHash,
          amountDegen: record.amountDegen,
          toWallet: record.toWallet,
        });

        if (record.sideEffect) {
          await kv.set(record.sideEffect.kvKey, record.sideEffect.kvValue);
        }

        return NextResponse.json({ ok: true, retried: record.id, txHash });
      } finally {
        await releaseLock(lockKey);
      }
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/failed-payouts] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
