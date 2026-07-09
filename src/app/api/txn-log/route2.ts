// app/api/txn-log/route.ts
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";

export type TxnLogEntry = {
  // fid, or "wallet:0x..." for Base App identities — same convention as
  // FailedPayout in lib/referral.ts. The client (Client.tsx logTransaction)
  // and lib/referral.ts's logDegenTxn already send the wallet-string form
  // for Base users; this type was just never updated to match, which is
  // exactly the kind of drift that broke the admin/failed-payouts build.
  fid: number | string;
  // "minigame_cashout" is written directly by lib/minigames.ts's
  // logCashoutTxn() (self-contained copy of this route's write path, same
  // reasoning as this file's own header comment about drift) — covers a
  // Coin Toss cash-out that actually sent DEGEN on-chain, whether auto-sent
  // or fulfilled from the admin queue.
  type: "accessory_unlock" | "checkin" | "referral_join" | "referral_checkin" | "wheel_spin" | "minigame_cashout";
  txHash: string;
  amountUsd: number;
  amountDegen?: number;
  toFid?: number | string;
  toWallet?: string;
  accessoryId?: string;
  accessoryName?: string;
  ts: number;
};

// POST is called from the app itself (on-chain actions) — no secret needed here,
// but you may want to add one if your app can supply it.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as TxnLogEntry;

    if (!body.fid || !body.type || !body.txHash) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const entry: TxnLogEntry = { ...body, ts: body.ts ?? Date.now() };

    const userKey = `txn-log:${body.fid}`;
    const userLog: TxnLogEntry[] = (await kv.get<TxnLogEntry[]>(userKey)) ?? [];
    userLog.push(entry);
    if (userLog.length > 200) userLog.splice(0, userLog.length - 200);
    await kv.set(userKey, userLog);

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

// GET requires Clerk auth — used by the dashboard and debug tools only
export async function GET(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fid = req.nextUrl.searchParams.get("fid");
  const all = req.nextUrl.searchParams.get("all");
  const type = req.nextUrl.searchParams.get("type");

  try {
    let log: TxnLogEntry[] = [];

    if (all === "1") {
      log = (await kv.get<TxnLogEntry[]>("txn-log:all")) ?? [];
    } else if (fid) {
      log = (await kv.get<TxnLogEntry[]>(`txn-log:${fid}`)) ?? [];
    } else {
      return NextResponse.json({ error: "Provide ?fid= or ?all=1" }, { status: 400 });
    }

    if (type) {
      log = log.filter((e) => e.type === type);
    }

    return NextResponse.json({ log: log.slice().reverse() });
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch log" }, { status: 500 });
  }
}
