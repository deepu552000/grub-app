// app/api/admin/dashboard/route.ts
// GET /api/admin/dashboard?secret=xxx
// Returns full picture: all txns, referral tree, revenue summary

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const allTxns: any[] = (await kv.get<any[]>("txn-log:all")) ?? [];

    // Revenue summary
    const usdcTxns   = allTxns.filter((t) => t.amountUsd > 0);
    const degenTxns  = allTxns.filter((t) => t.amountDegen > 0);
    const totalUsdc  = usdcTxns.reduce((s, t) => s + (t.amountUsd ?? 0), 0);
    const totalDegen = degenTxns.reduce((s, t) => s + (t.amountDegen ?? 0), 0);

    // Per-type breakdown
    const byType: Record<string, number> = {};
    for (const t of allTxns) {
      byType[t.type] = (byType[t.type] ?? 0) + 1;
    }

    // Unique paying users
    const payingFids = new Set(usdcTxns.map((t) => t.fid));

    // Referral tree — all referrers and their referred users
    // Scan KV keys pattern referrer:*:referred
    const referralTree: Record<string, any> = {};
    // We can't scan KV easily so build from txn log
    const joinTxns = allTxns.filter((t) => t.type === "referral_join");
    for (const t of joinTxns) {
      if (!referralTree[t.fid]) referralTree[t.fid] = { referrerFid: t.fid, referred: [], degenEarned: 0 };
      referralTree[t.fid].referred.push(t.toFid);
      referralTree[t.fid].degenEarned += t.amountDegen ?? 0;
    }
    const checkinPayouts = allTxns.filter((t) => t.type === "referral_checkin");
    for (const t of checkinPayouts) {
      if (!referralTree[t.fid]) referralTree[t.fid] = { referrerFid: t.fid, referred: [], degenEarned: 0 };
      referralTree[t.fid].degenEarned += t.amountDegen ?? 0;
    }

    return NextResponse.json({
      summary: {
        totalTxns: allTxns.length,
        totalUsdcRevenue: `$${totalUsdc.toFixed(2)}`,
        totalDegenPaidOut: totalDegen,
        uniquePayingUsers: payingFids.size,
        byType,
      },
      referralTree: Object.values(referralTree),
      recentTxns: allTxns.slice().reverse().slice(0, 50),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
