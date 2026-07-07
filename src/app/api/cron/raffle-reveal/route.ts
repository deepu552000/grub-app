// app/api/cron/raffle-reveal/route.ts
//
// Runs Sundays ~1 hour after raffle-lock (see vercel.json) — a generous
// buffer past the ~10 minute wait for the target block to actually be
// mined on Base. Reveals whichever round is "awaiting_reveal", pays out
// the winner's prize, and logs it to history.
//
// This is what makes payout happen the SAME day a round closes, instead of
// a full week later — the old single-cron raffle-draw route always
// deferred reveal to the following Sunday's run, since it was the only
// invocation guaranteed to land after the target block existed. Splitting
// lock and reveal into two scheduled runs the same day removes that need.
//
// If the target block somehow isn't mined yet (RPC hiccup — shouldn't
// happen with a 1-hour buffer for a ~10-minute wait, but just in case),
// revealRound() returns null and this is a safe no-op — the round stays
// "awaiting_reveal" and can be revealed manually via the admin dashboard's
// Force Draw Now button, without waiting for next Sunday.

import { NextRequest, NextResponse } from "next/server";
import { getAwaitingRevealRound, revealRound } from "@/lib/raffle";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const awaiting = await getAwaitingRevealRound();
    if (!awaiting) {
      console.log("[raffle-reveal] nothing awaiting reveal — no-op");
      return NextResponse.json({ ok: true, revealed: null });
    }

    const resolved = await revealRound(awaiting);
    const result = resolved
      ? { id: resolved.id, winnerKey: resolved.winnerKey, prizeTier: resolved.prizeTier, ticketCount: resolved.ticketCountAtLock }
      : { id: awaiting.id, skipped: "target block not yet mined — use Force Draw Now on the admin dashboard once it is" };

    console.log("[raffle-reveal]", JSON.stringify(result));
    return NextResponse.json({ ok: true, revealed: result });
  } catch (err: any) {
    console.error("[raffle-reveal] error:", err);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}
