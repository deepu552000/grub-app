// app/api/admin/raffle/route.ts
//
//   GET  /api/admin/raffle
//        Returns current open/awaiting-reveal round detail (entrants +
//        their ticket counts) plus recent history — for the admin
//        dashboard's new Raffle section.
//
//   POST /api/admin/raffle
//        Body: { action, roundId?, reason?, identityKey?, prizeKind?, accessoryId? }
//        action = "force_draw" | "force_reveal_only" | "set_prize_kind" |
//                 "send_degen_prize" | "grant_accessory_prize" |
//                 "void_round" | "refund_entrant" | "refund_all"
//        set_prize_kind needs roundId + prizeKind (only while round is open).
//        send_degen_prize / grant_accessory_prize need roundId (+ accessoryId
//        for the latter) — fulfill a resolved round's pending prize.
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
  getCurrentBlockNumberSafe,
  setRoundPrizeKind,
  payDegenPrize,
  grantAccessoryPrize,
  getFailedPrizePayouts,
  pickTierForKind,
  PRIZE_KINDS,
  PRIZE_KIND_LABELS,
  type PrizeKind,
} from "@/lib/raffle";

// Projects what the prize tier/amount would be for a given ticket count —
// used for both the open round (live, can still change as tickets sell) and
// the awaiting-reveal round (final, since ticketCountAtLock is frozen).
// "accessory" has no numeric tier — admin hand-picks the item at reveal —
// so this returns null for that kind rather than a fake amount.
function projectPrize(kind: PrizeKind | undefined | null, ticketCount: number) {
  if (!kind || kind === "accessory") return null;
  const tier = pickTierForKind(kind, ticketCount);
  if (!tier) return null;
  return { tierId: tier.id, value: tier.value, label: PRIZE_KIND_LABELS[kind] };
}

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

    const openTicketTotal = open ? await getLiveTicketTotal(open.id) : 0;
    const openDetail = open
      ? {
          ...open,
          ticketCount: openTicketTotal,
          entrants: await entrantsWithCounts(open.id),
          // Live projection — recomputes on every refresh as tickets sell,
          // so this can go up during the week; the real, frozen number is
          // whatever it shows the instant the round locks.
          projectedPrize: projectPrize(open.prizeKind, openTicketTotal),
        }
      : null;
    // currentBlock is only fetched here (on-demand, admin-triggered GET) —
    // never polled — so it costs one extra RPC call per manual dashboard
    // refresh, not a recurring background cost. Lets the dashboard show
    // "421/425" progress toward the target block instead of leaving the
    // admin guessing whether reveal is stuck or just not there yet.
    const awaitingDetail = awaiting
      ? {
          ...awaiting,
          entrants: await entrantsWithCounts(awaiting.id),
          currentBlock: awaiting.targetBlock ? await getCurrentBlockNumberSafe() : null,
          // Final — ticketCountAtLock is frozen at lock time, so unlike the
          // open round's projection, this number will not change again.
          projectedPrize: projectPrize(awaiting.prizeKind, awaiting.ticketCountAtLock ?? 0),
        }
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

    return NextResponse.json({
      ok: true,
      open: openDetail,
      awaitingReveal: awaitingDetail,
      history: historyWithEntrants,
      prizeKinds: PRIZE_KINDS.map((k) => ({ id: k, label: PRIZE_KIND_LABELS[k] })),
      failedPrizePayouts: await getFailedPrizePayouts(),
    });
  } catch (err: any) {
    console.error("[admin/raffle] GET error:", err);
    return NextResponse.json({ ok: false, reason: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await checkAuth(req))) return unauthorized();

    const body = await req.json();
    const { action, roundId, reason, identityKey, prizeKind, accessoryId } = body;

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

    // ── Reveal ONLY — does not touch the currently open round ───────────
    // force_draw (below/above) reveals + locks the open round + opens a new
    // one, all in one shot — fine for the intended weekly full-cycle use,
    // but that means retrying a stuck reveal by re-clicking force_draw also
    // force-locks whatever round is currently open and collecting entries,
    // even though it isn't done yet. This action is the safe way to retry
    // just the reveal step. Surfaces the raw RPC error (if any) and the
    // current/target block numbers so a stuck reveal is diagnosable instead
    // of silently staying "awaiting reveal" with no explanation.
    if (action === "force_reveal_only") {
      const awaiting = await getAwaitingRevealRound();
      if (!awaiting) {
        return NextResponse.json({ ok: false, reason: "no round is awaiting reveal" }, { status: 400 });
      }
      const currentBlock = await getCurrentBlockNumberSafe();
      try {
        const resolved = await revealRound(awaiting);
        if (!resolved) {
          const pastTarget = currentBlock != null && awaiting.targetBlock != null && currentBlock >= awaiting.targetBlock;
          return NextResponse.json({
            ok: true,
            action,
            revealed: null,
            reason: pastTarget
              ? "our RPC node returned no block for the target height even though we're past it — likely a lagging/rate-limited RPC node; check server logs and try again in a few seconds"
              : "target block not yet mined",
            targetBlock: awaiting.targetBlock,
            currentBlock,
          });
        }
        return NextResponse.json({
          ok: true,
          action,
          revealed: { id: resolved.id, winnerKey: resolved.winnerKey, prizeTier: resolved.prizeTier },
        });
      } catch (err: any) {
        console.error("[admin/raffle] force_reveal_only RPC error:", err);
        return NextResponse.json(
          {
            ok: false,
            action,
            reason: `RPC error while revealing: ${err?.message ?? "unknown error"}`,
            targetBlock: awaiting.targetBlock,
            currentBlock,
          },
          { status: 502 },
        );
      }
    }

    // ── Set (or change) the open round's prize kind ─────────────────────
    // Only works while the round is still "open" — setRoundPrizeKind()
    // itself enforces this and throws otherwise, so tickets already sold
    // never get retroactively promised a different prize.
    if (action === "set_prize_kind") {
      if (!roundId || !prizeKind) {
        return NextResponse.json({ ok: false, reason: "missing roundId or prizeKind" }, { status: 400 });
      }
      if (!PRIZE_KINDS.includes(prizeKind as PrizeKind)) {
        return NextResponse.json({ ok: false, reason: `unknown prizeKind "${prizeKind}"` }, { status: 400 });
      }
      try {
        const updated = await setRoundPrizeKind(roundId, prizeKind as PrizeKind);
        if (!updated) {
          return NextResponse.json({ ok: false, reason: `no round found with id ${roundId}` }, { status: 404 });
        }
        return NextResponse.json({ ok: true, action, roundId, prizeKind: updated.prizeKind });
      } catch (err: any) {
        return NextResponse.json({ ok: false, reason: err?.message ?? "could not set prize kind" }, { status: 400 });
      }
    }

    // ── Send a round's pending DEGEN prize ──────────────────────────────
    // Admin clicks this, the system builds and broadcasts the transfer from
    // the treasury wallet itself (same sendDegen() the referral payouts
    // use) — admin never enters an amount or tx hash by hand.
    if (action === "send_degen_prize") {
      if (!roundId) {
        return NextResponse.json({ ok: false, reason: "missing roundId" }, { status: 400 });
      }
      const result = await payDegenPrize(roundId);
      return NextResponse.json({ action, roundId, ...result });
    }

    // ── Grant a round's pending accessory prize ─────────────────────────
    // Admin picks the specific accessory (any stage/level) from a dropdown
    // and this writes it straight into the winner's closet.
    if (action === "grant_accessory_prize") {
      if (!roundId || !accessoryId) {
        return NextResponse.json({ ok: false, reason: "missing roundId or accessoryId" }, { status: 400 });
      }
      const result = await grantAccessoryPrize(roundId, accessoryId);
      return NextResponse.json({ action, roundId, accessoryId, ...result });
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
