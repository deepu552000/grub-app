// app/api/admin-backfill-txn-log/route.ts
// One-off backfill: reconstructs missing txn-log entries from the
// grub:used-tx:<txHash> records that /api/pet already writes on every
// successful unlock/checkin. Fixes the historical gap caused by
// logTransaction() previously bailing out for wallet-only (Base App) users.
//
// Safe to re-run — diffs against txn-log:all by txHash, so already-logged
// entries are never duplicated.
//
// Usage:
//   GET  /api/admin-backfill-txn-log   -> dry run, shows what WOULD be added
//   POST /api/admin-backfill-txn-log   -> actually writes the missing entries
// Both require the same Clerk Bearer token you use for /api/debug-kv.
//
// Delete this route once you've confirmed the backfill looks right — it's a
// one-time migration tool, not something that needs to stay live.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";
import { ACCESSORIES } from "@/lib/accessories";

// Mirrors app/api/pet/route.ts — keep in sync if that ever changes.
const CHECKIN_MICRO_USDC = 10_000; // $0.01

type TxnLogEntry = {
  fid: number | string;
  type: "accessory_unlock" | "checkin" | "referral_join" | "referral_checkin";
  txHash: string;
  amountUsd: number;
  amountDegen?: number;
  toFid?: number;
  toWallet?: string;
  accessoryId?: string;
  accessoryName?: string;
  ts: number;
};

const ACCESSORY_BY_ID = Object.fromEntries(ACCESSORIES.map((a) => [a.id, a]));

async function isAuthed(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    return true;
  } catch {
    return false;
  }
}

async function findMissingEntries(): Promise<TxnLogEntry[]> {
  const usedTxKeys = await kv.keys("grub:used-tx:*");
  const globalLog = (await kv.get<TxnLogEntry[]>("txn-log:all")) ?? [];
  const alreadyLogged = new Set(globalLog.map((e) => e.txHash));

  const missing: TxnLogEntry[] = [];

  for (const key of usedTxKeys) {
    const txHash = key.replace("grub:used-tx:", "");
    if (alreadyLogged.has(txHash)) continue;

    const record = await kv.get<any>(key);
    if (!record) continue;

    // Same identity convention used everywhere else: prefer fid, fall back
    // to wallet:<address> for Base App users with no Farcaster fid.
    const identityFid: string | number | null =
      record.fid ?? (record.wallet ? `wallet:${record.wallet}` : null);
    if (!identityFid) continue;

    if (record.accessoryId) {
      const acc = ACCESSORY_BY_ID[record.accessoryId];
      missing.push({
        fid: identityFid,
        type: "accessory_unlock",
        txHash,
        amountUsd: acc?.costUsd ?? 0,
        accessoryId: record.accessoryId,
        accessoryName: acc?.name,
        ts: record.ts ?? Date.now(),
      });
    } else if (record.purpose === "checkin") {
      missing.push({
        fid: identityFid,
        type: "checkin",
        txHash,
        amountUsd: CHECKIN_MICRO_USDC / 1_000_000,
        ts: record.ts ?? Date.now(),
      });
    }
    // Anything else (no accessoryId, purpose !== "checkin") isn't a payment
    // record we recognize — skipped rather than guessed at.
  }

  return missing;
}

// ── GET — dry run, no writes ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const missing = await findMissingEntries();
    return NextResponse.json({ dryRun: true, missingCount: missing.length, missing });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

// ── POST — actually backfill txn-log:all and each affected txn-log:<fid> ──
export async function POST(req: NextRequest) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const missing = await findMissingEntries();
    if (missing.length === 0) {
      return NextResponse.json({ ok: true, backfilled: 0, entries: [] });
    }

    // Group by fid so each per-user log is only read/written once.
    const byFid = new Map<string, TxnLogEntry[]>();
    for (const entry of missing) {
      const k = String(entry.fid);
      if (!byFid.has(k)) byFid.set(k, []);
      byFid.get(k)!.push(entry);
    }

    for (const [fidKey, entries] of byFid) {
      const userKey = `txn-log:${fidKey}`;
      const userLog: TxnLogEntry[] = (await kv.get<TxnLogEntry[]>(userKey)) ?? [];
      userLog.push(...entries);
      if (userLog.length > 200) userLog.splice(0, userLog.length - 200);
      await kv.set(userKey, userLog);
    }

    const globalKey = "txn-log:all";
    const globalLog: TxnLogEntry[] = (await kv.get<TxnLogEntry[]>(globalKey)) ?? [];
    globalLog.push(...missing);
    if (globalLog.length > 1000) globalLog.splice(0, globalLog.length - 1000);
    await kv.set(globalKey, globalLog);

    return NextResponse.json({ ok: true, backfilled: missing.length, entries: missing });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
