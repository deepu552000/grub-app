// app/api/admin/raffle/route.ts
//
//   GET  /api/admin/raffle
//        Returns current open/awaiting-reveal round detail (entrants +
//        their ticket counts) plus recent history — for the admin
//        dashboard's new Raffle section.
//
//   POST /api/admin/raffle
//        Body: { action, roundId?, reason?, identityKey? }
//        action = "force_draw" | "void_round" | "refund_entrant" | "refund_all"
//        refund_entrant needs identityKey too; refund_all only needs roundId
//        and only works on a "void" round (sends real USDC out of treasury).
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
  getRound,
  lockRound,
  revealRound,
  voidRound,
  ensureOpenRound,
  refundEntrant,
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

    // Voided rounds need their entrant list surfaced so the dashboard can
    // show a refund button per entrant (with amount = tickets × price) and
    // grey out anyone already covered by round.refunds. Skipped for
    // resolved/no_entrants history entries — nothing to refund there, no
    // reason to pay for the extra KV round-trips.
    const history = await getHistory();
    const historyWithEntrants = await Promise.all(
      history.map(async (r) => (r.status === "void" ? { ...r, entrants: await entrantsWithCounts(r.id) } : r)),
    );

    return NextResponse.json({ ok: true, open: openDetail, awaitingReveal: awaitingDetail, history: historyWithEntrants });
  } catch (err: any) {
    console.error("[admin/raffle] GET error:", err);
    return NextResponse.json({ ok: false, reason: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { action, roundId, reason, identityKey } = body;

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

    // ── Refund one entrant of a voided round ────────────────────────────
    // Sends real USDC out of the treasury. Idempotent — refundEntrant()
    // itself checks round.refunds, so a repeated click (or a double-tap on
    // a slow connection) is safe and just returns "already refunded".
    if (action === "refund_entrant") {
      if (!roundId || !identityKey) {
        return NextResponse.json({ ok: false, reason: "missing roundId or identityKey" }, { status: 400 });
      }
      const result = await refundEntrant(roundId, identityKey);
      return NextResponse.json({ action, roundId, identityKey, ...result });
    }

    // ── Refund every entrant of a voided round, one send each ───────────
    // Each entrant refunds independently — one failure (bad wallet lookup,
    // RPC hiccup, etc.) doesn't block or roll back the others. Check
    // `results` for any ok:false entries and retry those individually via
    // refund_entrant once the underlying issue is fixed.
    if (action === "refund_all") {
      if (!roundId) {
        return NextResponse.json({ ok: false, reason: "missing roundId" }, { status: 400 });
      }
      const round = await getRound(roundId);
      if (!round) {
        return NextResponse.json({ ok: false, reason: `no round found with id ${roundId}` }, { status: 404 });
      }
      const entrants = ((await kv.smembers(`grub:raffle:entrants:${roundId}`)) as string[] | null) ?? [];
      const results = [];
      for (const key of entrants) {
        const result = await refundEntrant(roundId, key);
        results.push({ identityKey: key, ...result });
      }
      return NextResponse.json({ ok: true, action, roundId, results });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/raffle] POST error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
