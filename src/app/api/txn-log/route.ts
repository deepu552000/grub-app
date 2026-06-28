// app/api/txn-log/route.ts
//
// Append-only transaction log stored in Vercel KV.
// Called after every confirmed on-chain payment (accessory unlock, check-in).
//
// KV structure:
//   txn-log:{fid}          → array of TxnLogEntry (per-user history, last 200)
//   txn-log:all            → array of TxnLogEntry (global log, last 1000)

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export type TxnLogEntry = {
  fid: number;
  type: "accessory_unlock" | "checkin";
  txHash: string;
  amountUsd: number;
  // accessory unlock only
  accessoryId?: string;
  accessoryName?: string;
  // metadata
  ts: number;       // Unix ms timestamp
  walletAddress?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as TxnLogEntry;

    // Basic validation
    if (!body.fid || !body.type || !body.txHash || !body.amountUsd) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const entry: TxnLogEntry = {
      ...body,
      ts: body.ts ?? Date.now(),
    };

    // Per-user log — keep last 200 entries
    const userKey = `txn-log:${body.fid}`;
    const userLog: TxnLogEntry[] = (await kv.get<TxnLogEntry[]>(userKey)) ?? [];
    userLog.push(entry);
    if (userLog.length > 200) userLog.splice(0, userLog.length - 200);
    await kv.set(userKey, userLog);

    // Global log — keep last 1000 entries
    const globalKey = "txn-log:all";
    const globalLog: TxnLogEntry[] = (await kv.get<TxnLogEntry[]>(globalKey)) ?? [];
    globalLog.push(entry);
    if (globalLog.length > 1000) globalLog.splice(0, globalLog.length - 1000);
    await kv.set(globalKey, globalLog);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("txn-log error:", err);
    return NextResponse.json({ error: "Failed to log transaction" }, { status: 500 });
  }
}

// GET — fetch logs for a specific FID (for admin/debug use)
export async function GET(req: NextRequest) {
  const fid = req.nextUrl.searchParams.get("fid");
  const all = req.nextUrl.searchParams.get("all");

  try {
    if (all === "1") {
      const globalLog = (await kv.get<TxnLogEntry[]>("txn-log:all")) ?? [];
      return NextResponse.json({ log: globalLog.slice().reverse() }); // newest first
    }
    if (fid) {
      const userLog = (await kv.get<TxnLogEntry[]>(`txn-log:${fid}`)) ?? [];
      return NextResponse.json({ log: userLog.slice().reverse() }); // newest first
    }
    return NextResponse.json({ error: "Provide ?fid= or ?all=1" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch log" }, { status: 500 });
  }
}
