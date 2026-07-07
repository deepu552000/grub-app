// app/api/admin/raffle/route.ts
//
//   GET  /api/admin/raffle
//        Returns current open/awaiting-reveal round detail (entrants +
//        their ticket counts) plus recent history — for the admin
//        dashboard's new Raffle section.
//
//   POST /api/admin/raffle
//        Body: { action, roundId?, reason? }
//        action = "force_draw" | "void_round"
//
// Auth follows the exact same Clerk-session pattern as
// /api/admin/user-control — see that file if this ever needs to change.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getAuth } from "@clerk/nextjs/server";
import {
  getOpenRound,
  getAwaitingRevealRound,
  getLiveTicketTotal,
  getTicketCount,
  getHistory,
  lockRound,
  revealRound,
  voidRound,
  ensureOpenRound,
} from "@/lib/raffle";

function unauthorized() {
  return NextResponse.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
}

async function checkAuth(req: NextRequest) {
  try {
    const { userId } = getAuth(req);
    return !!userId;
  } catch {
    return false;
  }
}

async function entrantsWithCounts(roundId: string) {
  const entrants = (await kv.smembers(`grub:raffle:entrants:${roundId}`)) as string[] | null;
  if (!entrants) return [];
  const withCounts = await Promise.all(
    entrants.map(async (identityKey) => ({
      identityKey,
      tickets: await getTicketCount(roundId, identityKey),
    })),
  );
  return withCounts.sort((a, b) => b.tickets - a.tickets);
}

export async function GET(req: NextRequest) {
  if (!(await checkAuth(req))) return unauthorized();

  try {
    const open = await getOpenRound();
    const awaiting = await getAwaitingRevealRound();

    const openDetail = open
      ? { ...open, ticketCount: await getLiveTicketTotal(open.id), entrants: await entrantsWithCounts(open.id) }
      : null;
    const awaitingDetail = awaiting
      ? { ...awaiting, entrants: await entrantsWithCounts(awaiting.id) }
      : null;

    const history = await getHistory();

    return NextResponse.json({ ok: true, open: openDetail, awaitingReveal: awaitingDetail, history });
  } catch (err: any) {
    console.error("[admin/raffle] GET error:", err);
    return NextResponse.json({ ok: false, reason: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { action, roundId, reason } = body;

    // ── Force a draw right now, out of schedule ─────────────────────────
    // Runs the same reveal→lock→open sequence the Sunday cron does. Use
    // this if you need to trigger a draw early for any reason — it's safe
    // to run even if the cron already ran this week, since each step is a
    // no-op when there's nothing for it to do (see the cron route's
    // top-of-file comment).
    if (action === "force_draw") {
      const result: any = { revealed: null, locked: null, opened: null };

      const awaiting = await getAwaitingRevealRound();
      if (awaiting) {
        const resolved = await revealRound(awaiting);
        result.revealed = resolved
          ? { id: resolved.id, winnerKey: resolved.winnerKey, prizeTier: resolved.prizeTier }
          : { id: awaiting.id, skipped: "target block not yet mined" };
      }

      const open = await getOpenRound();
      if (open) {
        const locked = await lockRound(open);
        result.locked = { id: locked.id, status: locked.status, ticketCount: locked.ticketCountAtLock };
      }

      const next = await ensureOpenRound();
      result.opened = { id: next.id };

      return NextResponse.json({ ok: true, action, ...result });
    }

    // ── Void an in-flight round without drawing a winner ────────────────
    // Does not auto-refund entrants — same philosophy as the rest of the
    // admin toolkit (grant_credit/revoke_credit etc. are manual, deliberate
    // corrections, not automated reversals). Refund per-entrant by hand if
    // a void round ever needs it.
    if (action === "void_round") {
      if (!roundId) {
        return NextResponse.json({ ok: false, reason: "missing roundId" }, { status: 400 });
      }
      const voided = await voidRound(roundId, reason ?? "voided by admin");
      if (!voided) {
        return NextResponse.json({ ok: false, reason: `no round found with id ${roundId}` }, { status: 404 });
      }
      // Ensure a fresh open round exists after voiding, so ticket sales can
      // continue immediately rather than waiting for next Sunday's cron.
      const next = await ensureOpenRound();
      return NextResponse.json({ ok: true, action, voided, newOpenRoundId: next.id });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/raffle] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
