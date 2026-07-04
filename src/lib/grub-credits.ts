// lib/grub-credits.ts
//
// Shared helpers for the two Spin Wheel credit counters — Free Check-in and
// Streak Save. These live as their OWN atomic KV keys (via Redis INCRBY /
// DECRBY), separate from the big grub:pet:<id> state blob. That's the fix
// for the race that wiped fid 3325017's credits: as long as these numbers
// were just fields inside the same JSON blob as everything else (xp, hunger,
// accessories...), any two overlapping whole-state saves could clobber each
// other — whichever request's `kv.set` landed last won, even if it was
// carrying an older, lower credit count. INCRBY/DECRBY are atomic at the
// Redis level, so two concurrent "+1" calls can never step on each other.
//
// Used by:
//   - /api/pet          → grantCredit() on a Spin Wheel win,
//                          spendCreditIfAvailable() when a checkin consumes one.
//   - /api/admin/user-control → grantCredit() for manual corrections.
//
// IMPORTANT invariant: both callers ALSO mirror the resulting value back
// into the grub:pet:<id> blob's freeCheckinCredits/streakSaveCredits fields
// after every call here (see the // MIRROR comments at each call site). The
// atomic keys are the source of truth; the blob copy exists only so
// GET /api/pet and the debug-kv dashboard (which read the blob directly)
// stay accurate without extra plumbing. If you add a new place that touches
// credits, mirror the value into the blob too, or the dashboard will lag.

import { kv } from "@vercel/kv";

export type CreditType = "freeCheckin" | "streakSave";

export function creditKey(baseKey: string, type: CreditType): string {
  return `${baseKey}:credit:${type === "freeCheckin" ? "free" : "streak"}`;
}

export async function getCredits(
  baseKey: string
): Promise<{ freeCheckinCredits: number; streakSaveCredits: number }> {
  const [free, streak] = await Promise.all([
    kv.get<number>(creditKey(baseKey, "freeCheckin")),
    kv.get<number>(creditKey(baseKey, "streakSave")),
  ]);
  return { freeCheckinCredits: free ?? 0, streakSaveCredits: streak ?? 0 };
}

// Atomically add credits — Spin Wheel win or admin grant. Always safe, no
// read-then-write race possible.
export async function grantCredit(baseKey: string, type: CreditType, amount = 1): Promise<number> {
  return await kv.incrby(creditKey(baseKey, type), amount);
}

// Atomically spend ONE credit, never going below 0. Returns the new balance,
// or null if there was nothing to spend — callers should treat null as "the
// client's claimed consumption doesn't match server truth, ignore it" rather
// than trusting whatever the client sent.
export async function spendCreditIfAvailable(baseKey: string, type: CreditType): Promise<number | null> {
  const key = creditKey(baseKey, type);
  const newValue = await kv.decrby(key, 1);
  if (newValue < 0) {
    // Nothing was actually available — put it back rather than leaving a
    // negative balance sitting in KV.
    await kv.set(key, 0);
    return null;
  }
  return newValue;
}

// Atomically REMOVE credits — admin correction only (e.g. undoing an
// accidental double-grant). Unlike spendCreditIfAvailable above, this is not
// a real in-game spend gated on availability — it's a manual fix, so it
// always succeeds and just floors at 0 rather than failing when `amount`
// exceeds what's banked.
export async function revokeCredit(baseKey: string, type: CreditType, amount = 1): Promise<number> {
  const key = creditKey(baseKey, type);
  const newValue = await kv.decrby(key, amount);
  if (newValue < 0) {
    await kv.set(key, 0);
    return 0;
  }
  return newValue;
}
