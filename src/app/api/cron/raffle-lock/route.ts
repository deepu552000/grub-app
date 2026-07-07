// app/api/cron/raffle-lock/route.ts
//
// Runs Sundays at 00:00 UTC via Vercel Cron (see vercel.json). Does two
// things, in order:
//
//   1. LOCK whatever round is currently "open" (been selling tickets all
//      week) — snapshots its ticket total and commits to a future block
//      (~10 min out on Base) whose hash will decide the winner.
//   2. OPEN a new round immediately, so ticket sales continue with no gap.
//
// Deliberately does NOT reveal anything — that's /api/cron/raffle-reveal's
// job, running ~1 hour later. Splitting lock and reveal into two separate
// cron jobs (instead of one job doing both, like the old raffle-draw route
// did) is what makes same-week payout possible: a serverless function can't
// just sleep for 10 minutes waiting on a block to be mined, so the wait has
// to happen BETWEEN two scheduled invocations, not inside one of them.
//
// Safe to re-run: locking is a no-op if nothing's open, ensureOpenRound()
// is a no-op if a round is already open.

import { NextRequest, NextResponse } from "next/server";
import { getOpenRound, lockRound, ensureOpenRound } from "@/lib/raffle";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result: any = { locked: null, opened: null };

  try {
    const open = await getOpenRound();
    if (open) {
      const locked = await lockRound(open);
      result.locked = { id: locked.id, status: locked.status, ticketCount: locked.ticketCountAtLock, targetBlock: locked.targetBlock };
    }

    const next = await ensureOpenRound();
    result.opened = { id: next.id, locksAt: next.locksAt };

    console.log("[raffle-lock]", JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[raffle-lock] error:", err);
    return NextResponse.json({ ok: false, error: err?.message, partial: result }, { status: 500 });
  }
}
