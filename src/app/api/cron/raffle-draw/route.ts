// app/api/cron/raffle-draw/route.ts
//
// Runs Sundays via Vercel Cron (see vercel.json — its own separate cron
// entry, independent of hunger-alert's daily one). Each run does up to
// three things in order:
//
//   1. REVEAL whatever round is "awaiting_reveal" (locked last Sunday —
//      its committed block is guaranteed mined by now, a full week later,
//      so this never needs to poll/wait).
//   2. LOCK whatever round is currently "open" (been selling tickets all
//      week) — snapshots its ticket total and commits to a future block
//      for NEXT week's reveal.
//   3. OPEN a new round for the coming week.
//
// Steps are independent and safe to re-run: if this invocation fails
// partway (e.g. after reveal but before lock), next Sunday's run just picks
// up whatever's still pending — reveal is a no-op if nothing's awaiting
// reveal, lock is a no-op if nothing's open, ensureOpenRound() is a no-op
// if something's already open.

import { NextRequest, NextResponse } from "next/server";
import {
  getAwaitingRevealRound,
  getOpenRound,
  revealRound,
  lockRound,
  ensureOpenRound,
} from "@/lib/raffle";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result: any = { revealed: null, locked: null, opened: null };

  try {
    // ── 1. Reveal last week's locked round ────────────────────────────────
    const awaiting = await getAwaitingRevealRound();
    if (awaiting) {
      const resolved = await revealRound(awaiting);
      result.revealed = resolved
        ? { id: resolved.id, winnerKey: resolved.winnerKey, prizeTier: resolved.prizeTier, ticketCount: resolved.ticketCountAtLock }
        : { id: awaiting.id, skipped: "target block not yet mined — will retry next run" };
    }

    // ── 2. Lock this week's open round ────────────────────────────────────
    const open = await getOpenRound();
    if (open) {
      const locked = await lockRound(open);
      result.locked = { id: locked.id, status: locked.status, ticketCount: locked.ticketCountAtLock };
    }

    // ── 3. Open next week's round ──────────────────────────────────────────
    const next = await ensureOpenRound();
    result.opened = { id: next.id, locksAt: next.locksAt };

    console.log("[raffle-draw]", JSON.stringify(result));
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[raffle-draw] error:", err);
    return NextResponse.json({ ok: false, error: err?.message, partial: result }, { status: 500 });
  }
}
