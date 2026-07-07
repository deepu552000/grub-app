// lib/raffle.ts
//
// Core Raffle logic — round lifecycle, ticket bookkeeping, weighted winner
// selection, and prize granting. Used by:
//   - app/api/raffle/route.ts        (buy a ticket, read round status)
//   - app/api/cron/raffle-draw/route.ts (weekly reveal + lock + open)
//   - app/api/admin/raffle/route.ts  (dashboard view, force-draw, void)
//
// ── Design summary ───────────────────────────────────────────────────────
// One round is always "open" for ticket sales. Every Sunday the cron:
//   1. REVEALS the round that was locked the previous Sunday (its target
//      block is guaranteed mined by now — a full week has passed — so no
//      same-day polling/waiting is ever needed).
//   2. LOCKS the round that's been open all week: snapshots its ticket
//      count and commits to a future block number whose hash will decide
//      the winner. This commit happens BEFORE that block is mined, so
//      nobody (including us) can know the outcome at commit time — that's
//      what makes the draw verifiable rather than "trust us."
//   3. OPENS a brand new round for the coming week.
//
// A round with zero tickets sold by lock time skips straight to
// "no_entrants" — no target block, no reveal needed, no winner.
//
// ── KV shape ─────────────────────────────────────────────────────────────
//   grub:raffle:pointers                  → { openId, awaitingRevealId }
//   grub:raffle:round:<id>                → RaffleRound
//   grub:raffle:tickets:<roundId>:<key>   → number (atomic incrby; <key> is
//                                            the SAME string petKey() would
//                                            produce, so a raffle entrant is
//                                            just "whoever owns this pet")
//   grub:raffle:entrants:<roundId>        → Redis SET of the above keys —
//                                            lets us list who's in without
//                                            scanning the whole KV namespace
//   grub:raffle:history                   → capped list of resolved rounds

import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { acquireLock, releaseLock, getWalletFromNeynar } from "@/lib/referral";

// ── Constants ────────────────────────────────────────────────────────────────
export const TICKET_PRICE_MICRO_USDC = 100_000; // $0.10
export const MAX_TICKETS_PER_USER_PER_ROUND = 3;

// Same USDC contract the purchase route (app/api/raffle/route.ts) verifies
// incoming payments against — used here for the reverse direction (sending a
// refund back OUT of the treasury) when an admin voids a round.
const REFUND_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];
const ERC20_TRANSFER_IFACE = new ethers.Interface(ERC20_TRANSFER_ABI);

// Base produces a block roughly every 2s. 300 blocks ≈ 10 minutes — long
// enough that the block is nowhere near mined at commit time (so the
// outcome truly can't be known yet), short enough that it's always mined
// well before the NEXT week's cron run comes around to reveal it.
export const BLOCKS_AHEAD_FOR_DRAW = 300;

const BASE_RPC = "https://mainnet.base.org";

export type PrizeTier = {
  id: string;
  type: "xp"; // "accessory" | "degen" land here later — see grantPrize()
  value: number;
  minTickets: number;
};

// Ordered low → high. pickTier() walks this and keeps the last one whose
// minTickets is met, so add new tiers here without touching any call site.
// Only "xp" is populated for v1, per plan — the shape already supports
// heavier tiers (accessory/degen) so adding one later is a data change,
// not a code change, as long as grantPrize() below gets a matching case.
export const PRIZE_TIERS: PrizeTier[] = [
  { id: "small", type: "xp", value: 25, minTickets: 1 },
  { id: "medium", type: "xp", value: 100, minTickets: 7 },
];

export function pickTier(ticketCount: number): PrizeTier | null {
  if (ticketCount <= 0) return null;
  let tier: PrizeTier | null = null;
  for (const t of PRIZE_TIERS) {
    if (ticketCount >= t.minTickets) tier = t;
  }
  return tier;
}

export type RaffleRoundStatus = "open" | "awaiting_reveal" | "resolved" | "no_entrants" | "void";

export type RaffleRound = {
  id: string; // ISO date of the Sunday this round opened, e.g. "2026-07-12"
  status: RaffleRoundStatus;
  ticketPriceMicroUsdc: number;
  openedAt: number;
  locksAt: number; // informational — the Sunday cutoff this round targets
  lockedAt?: number;
  ticketCountAtLock?: number;
  targetBlock?: number;
  drawnBlockHash?: string;
  winnerKey?: string; // petKey() of the winner, once resolved
  prizeTier?: PrizeTier;
  resolvedAt?: number;
  voidedAt?: number;
  voidReason?: string;
  // Per-entrant refund receipts for a voided round — keyed by identityKey
  // (same key recordTicketPurchase used). Presence of a key here is what
  // makes refundEntrant() idempotent: a second click can't double-pay.
  refunds?: Record<string, { txHash: string; amountMicroUsdc: number; wallet: string; refundedAt: number }>;
};

function roundKey(id: string) {
  return `grub:raffle:round:${id}`;
}
function ticketsKey(roundId: string, identityKey: string) {
  return `grub:raffle:tickets:${roundId}:${identityKey}`;
}
function entrantsKey(roundId: string) {
  return `grub:raffle:entrants:${roundId}`;
}
const POINTERS_KEY = "grub:raffle:pointers";
const HISTORY_KEY = "grub:raffle:history";
const HISTORY_MAX = 52; // a year's worth of weekly rounds — plenty for a "past winners" list

type Pointers = { openId: string | null; awaitingRevealId: string | null };

async function getPointers(): Promise<Pointers> {
  return (await kv.get<Pointers>(POINTERS_KEY)) ?? { openId: null, awaitingRevealId: null };
}
async function setPointers(p: Pointers) {
  await kv.set(POINTERS_KEY, p);
}

export async function getRound(id: string): Promise<RaffleRound | null> {
  return await kv.get<RaffleRound>(roundKey(id));
}

export async function getOpenRound(): Promise<RaffleRound | null> {
  const { openId } = await getPointers();
  return openId ? await getRound(openId) : null;
}

export async function getAwaitingRevealRound(): Promise<RaffleRound | null> {
  const { awaitingRevealId } = await getPointers();
  return awaitingRevealId ? await getRound(awaitingRevealId) : null;
}

/** Ticket count for one identity in one round — reads the atomic counter directly. */
export async function getTicketCount(roundId: string, identityKey: string): Promise<number> {
  return (await kv.get<number>(ticketsKey(roundId, identityKey))) ?? 0;
}

/** Next Sunday 00:00 UTC, used as the informational `locksAt` on a freshly opened round. */
function nextSundayUtc(from: number): number {
  const d = new Date(from);
  const day = d.getUTCDay(); // 0 = Sunday
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilSunday));
  return next.getTime();
}

/**
 * Opens a brand new round if one isn't already open — called by the cron
 * after locking the previous one, and lazily by the purchase route just in
 * case the cron hasn't run yet (e.g. very first deploy).
 *
 * IDs are date-based ("2026-07-07") for readability, but that's only unique
 * under the cron's normal weekly cadence (a full week passes between a
 * round opening and the next one opening). force_draw can lock+reopen on
 * the SAME calendar day, which would otherwise generate the identical id
 * for the new round as the one just locked — colliding on the same KV key
 * (roundKey(id)) and silently overwriting the just-locked round's data
 * (and, since tickets/entrants are keyed by roundId too, carrying its
 * ticket counts into the "new" round). Guard against that by suffixing the
 * id if a round already exists for today's date.
 */
export async function ensureOpenRound(): Promise<RaffleRound> {
  const existing = await getOpenRound();
  if (existing) return existing;

  const now = Date.now();
  let id = new Date(now).toISOString().slice(0, 10);
  if (await getRound(id)) {
    // Collision — today's date-id is already taken by a round that was
    // just locked/voided/resolved. Disambiguate with a short suffix rather
    // than clobbering it.
    let suffix = 2;
    while (await getRound(`${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const round: RaffleRound = {
    id,
    status: "open",
    ticketPriceMicroUsdc: TICKET_PRICE_MICRO_USDC,
    openedAt: now,
    locksAt: nextSundayUtc(now),
  };
  await kv.set(roundKey(id), round);
  const pointers = await getPointers();
  await setPointers({ ...pointers, openId: id });
  return round;
}

/**
 * Records one paid ticket. Caller (the purchase route) is responsible for
 * payment verification and replay protection BEFORE calling this — this
 * function only does the bookkeeping, and assumes the payment already
 * cleared. Returns the buyer's new ticket count for this round, or null if
 * the per-user cap was hit (checked again here, atomically, in case of a
 * race between two concurrent purchase requests from the same identity).
 */
export async function recordTicketPurchase(
  round: RaffleRound,
  identityKey: string,
): Promise<{ newCount: number; roundTotal: number } | null> {
  const before = await getTicketCount(round.id, identityKey);
  if (before >= MAX_TICKETS_PER_USER_PER_ROUND) return null;

  const newCount = await kv.incr(ticketsKey(round.id, identityKey));
  // Double-check post-increment in case of a genuine race — if two requests
  // both read `before < cap` at once, both increments happen, but only the
  // one landing AT or under the cap should be honored. Anything over gets
  // rolled back so a burst of concurrent clicks can't exceed the cap.
  if (newCount > MAX_TICKETS_PER_USER_PER_ROUND) {
    await kv.decr(ticketsKey(round.id, identityKey));
    return null;
  }

  await kv.sadd(entrantsKey(round.id), identityKey);
  const updated = { ...round, ticketCountAtLock: undefined }; // ticketCount is derived live, not stored, until lock
  void updated;
  const roundTotal = await getLiveTicketTotal(round.id);
  return { newCount, roundTotal };
}

/** Live (pre-lock) total across all entrants — sums the entrant set's counters. Fine at this scale (weekly rounds, expected to be dozens–hundreds of entrants, not millions). */
export async function getLiveTicketTotal(roundId: string): Promise<number> {
  const entrants = (await kv.smembers(entrantsKey(roundId))) as string[] | null;
  if (!entrants || entrants.length === 0) return 0;
  const counts = await Promise.all(entrants.map((k) => getTicketCount(roundId, k)));
  return counts.reduce((a, b) => a + b, 0);
}

// ── Base RPC helpers ─────────────────────────────────────────────────────────
async function rpc(method: string, params: any[]): Promise<any> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json?.error) throw new Error(`Base RPC error: ${json.error.message ?? "unknown"}`);
  return json?.result;
}

async function getCurrentBlockNumber(): Promise<number> {
  const hex = await rpc("eth_blockNumber", []);
  return parseInt(hex, 16);
}

/** Returns the block hash, or null if that block hasn't been mined yet. */
async function getBlockHash(blockNumber: number): Promise<string | null> {
  const hexBlock = "0x" + blockNumber.toString(16);
  const block = await rpc("eth_getBlockByNumber", [hexBlock, false]);
  return block?.hash ?? null;
}

/**
 * Locks the given round: snapshots its final ticket total and, if that
 * total is > 0, commits to a future block whose hash will decide the
 * winner. A zero-ticket round skips straight to "no_entrants" — nothing to
 * reveal, no target block needed.
 *
 * Must be called BEFORE the target block exists (i.e. right now, using the
 * current block number as the baseline) — that ordering is the entire
 * point: the commit is made public (stored in the round record) before the
 * outcome can possibly be known.
 */
export async function lockRound(round: RaffleRound): Promise<RaffleRound> {
  const ticketCount = await getLiveTicketTotal(round.id);
  const now = Date.now();

  if (ticketCount === 0) {
    const resolved: RaffleRound = {
      ...round,
      status: "no_entrants",
      ticketCountAtLock: 0,
      lockedAt: now,
      resolvedAt: now,
    };
    await kv.set(roundKey(round.id), resolved);
    await pushHistory(resolved);
    const pointers = await getPointers();
    await setPointers({ ...pointers, openId: null });
    return resolved;
  }

  const currentBlock = await getCurrentBlockNumber();
  const targetBlock = currentBlock + BLOCKS_AHEAD_FOR_DRAW;

  const locked: RaffleRound = {
    ...round,
    status: "awaiting_reveal",
    ticketCountAtLock: ticketCount,
    targetBlock,
    lockedAt: now,
  };
  await kv.set(roundKey(round.id), locked);
  const pointers = await getPointers();
  await setPointers({ openId: null, awaitingRevealId: round.id });
  return locked;
}

/**
 * Reveals a locked round: fetches the committed block's hash and derives
 * the winner deterministically. Returns null (does nothing) if the target
 * block somehow isn't mined yet — shouldn't happen a week later, but Base
 * RPC hiccups happen, and it's safer to retry next run than to fail loudly
 * on a cron nobody's watching in real time.
 */
export async function revealRound(round: RaffleRound): Promise<RaffleRound | null> {
  if (round.status !== "awaiting_reveal" || !round.targetBlock) return null;

  const hash = await getBlockHash(round.targetBlock);
  if (!hash) {
    console.warn(`[raffle] target block ${round.targetBlock} for round ${round.id} not yet mined — will retry next run`);
    return null;
  }

  const entrants = (await kv.smembers(entrantsKey(round.id))) as string[] | null;
  if (!entrants || entrants.length === 0) {
    // Shouldn't happen — lockRound() already routes zero-entrant rounds to
    // "no_entrants" before this point — but guard anyway rather than crash.
    const resolved: RaffleRound = { ...round, status: "no_entrants", resolvedAt: Date.now() };
    await kv.set(roundKey(round.id), resolved);
    await pushHistory(resolved);
    return resolved;
  }

  // Build the weighted list: each entrant appears once per ticket they hold.
  // Fine at this scale (rounds are expected in the dozens-to-low-hundreds of
  // total tickets, not millions) — see getLiveTicketTotal()'s comment.
  const weighted: string[] = [];
  for (const identityKey of entrants) {
    const count = await getTicketCount(round.id, identityKey);
    for (let i = 0; i < count; i++) weighted.push(identityKey);
  }

  // Deterministic, publicly-recomputable: anyone can take the same block
  // hash and ticket list and arrive at the same index themselves.
  const seed = BigInt(hash);
  const winnerIndex = Number(seed % BigInt(weighted.length));
  const winnerKey = weighted[winnerIndex];

  const tier = pickTier(round.ticketCountAtLock ?? weighted.length);

  const resolved: RaffleRound = {
    ...round,
    status: "resolved",
    drawnBlockHash: hash,
    winnerKey,
    prizeTier: tier ?? undefined,
    resolvedAt: Date.now(),
  };
  await kv.set(roundKey(round.id), resolved);

  if (tier) await grantPrize(winnerKey, tier);

  await pushHistory(resolved);
  const pointers = await getPointers();
  await setPointers({ ...pointers, awaitingRevealId: null });
  return resolved;
}

/** Grants the tier's prize to the winner's pet record. XP-only for v1 — see PrizeTier's type comment for how future tiers plug in here. */
async function grantPrize(winnerKey: string, tier: PrizeTier) {
  const state = await kv.get<any>(winnerKey);
  if (!state) {
    console.error(`[raffle] winner key ${winnerKey} has no pet state — cannot grant prize`);
    return;
  }
  if (tier.type === "xp") {
    await kv.set(winnerKey, { ...state, xp: (state.xp ?? 0) + tier.value });
  }
  // "accessory" / "degen" tiers land here later, each granting via the same
  // helpers unlock_accessory / sendDegen already use elsewhere — this
  // function is the one place a new tier type needs a matching case.
}

async function pushHistory(round: RaffleRound) {
  const history = (await kv.get<RaffleRound[]>(HISTORY_KEY)) ?? [];
  const next = [round, ...history].slice(0, HISTORY_MAX);
  await kv.set(HISTORY_KEY, next);
}

export async function getHistory(): Promise<RaffleRound[]> {
  return (await kv.get<RaffleRound[]>(HISTORY_KEY)) ?? [];
}

/**
 * Turns a raw identityKey (grub:pet:<fid> or grub:pet:wallet:<address>) into
 * a display-safe label for the PUBLIC "previous rounds" list — never expose
 * the raw KV key format to clients. Wallet addresses get shortened the same
 * way the referral dashboard shortens them (shortenAddress in lib/referral.ts);
 * fids show as "fid:1234" since Grub has no public username without a Neynar
 * call, which isn't worth doing just for a small history list.
 */
export function publicWinnerLabel(identityKey?: string | null): string | null {
  if (!identityKey) return null;
  const WALLET_PREFIX = "grub:pet:wallet:";
  if (identityKey.startsWith(WALLET_PREFIX)) {
    const addr = identityKey.slice(WALLET_PREFIX.length);
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }
  const fid = identityKey.replace(/^grub:pet:/, "");
  return `fid:${fid}`;
}

/** Admin escape hatch — voids an in-flight round without drawing a winner (e.g. a bug is discovered mid-round). Does NOT refund tickets automatically; refundEntrant()/refund_entrant below is the manual per-entrant follow-up step. */
export async function voidRound(roundId: string, reason: string): Promise<RaffleRound | null> {
  const round = await getRound(roundId);
  if (!round) return null;
  const voided: RaffleRound = { ...round, status: "void", voidedAt: Date.now(), voidReason: reason };
  await kv.set(roundKey(roundId), voided);
  const pointers = await getPointers();
  const next = { ...pointers };
  if (pointers.openId === roundId) next.openId = null;
  if (pointers.awaitingRevealId === roundId) next.awaitingRevealId = null;
  await setPointers(next);
  await pushHistory(voided);
  return voided;
}

// ── Refunds ──────────────────────────────────────────────────────────────────
// Manual, admin-triggered — voidRound() never auto-refunds. Each entrant in a
// voided round gets refunded individually (one on-chain send each) so a
// partial failure only affects that one entrant, not the whole batch.

/**
 * Given a raffle identityKey (same string petKey() produces — either
 * "grub:pet:<fid>" or "grub:pet:wallet:<address>"), resolve the wallet
 * address a refund should be sent to.
 *
 *  - Wallet-based identity: the address IS the identityKey, no lookup needed.
 *  - Fid-based identity: check the ref:<fid>:wallet cache the referral system
 *    already maintains (populated whenever that fid was ever a referrer);
 *    fall back to a live Neynar lookup and cache the result the same way
 *    registerReferral() does, so future refunds/payouts for this fid are free.
 */
export async function resolveEntrantWallet(identityKey: string): Promise<string | null> {
  const WALLET_PREFIX = "grub:pet:wallet:";
  if (identityKey.startsWith(WALLET_PREFIX)) {
    return identityKey.slice(WALLET_PREFIX.length);
  }

  const fidStr = identityKey.replace(/^grub:pet:/, "");
  const fid = Number(fidStr);
  if (!fid || Number.isNaN(fid)) return null;

  const cached = await kv.get<string>(`ref:${fid}:wallet`);
  if (cached) return cached;

  const resolved = await getWalletFromNeynar(fid);
  if (resolved) await kv.set(`ref:${fid}:wallet`, resolved);
  return resolved;
}

/**
 * Sends a USDC refund from the treasury wallet. Same broadcast-vs-confirm
 * split as sendDegen() in lib/referral.ts: if tx.wait() throws, the transfer
 * may already be on-chain — the error carries broadcastTxHash so the caller
 * never blindly retries money that already moved.
 */
async function sendUsdcFromTreasury(toAddress: string, microUsdc: number): Promise<string> {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL ?? "https://mainnet.base.org");
  const treasury = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY!, provider);
  const data = ERC20_TRANSFER_IFACE.encodeFunctionData("transfer", [toAddress, BigInt(microUsdc)]);

  const tx = await treasury.sendTransaction({ to: REFUND_USDC_CONTRACT, data });

  try {
    await tx.wait();
  } catch (waitErr: any) {
    const err = new Error(
      `Refund broadcast (tx ${tx.hash}) but confirmation failed: ${waitErr?.reason ?? waitErr?.shortMessage ?? waitErr?.message ?? waitErr}. ` +
      `The USDC may already have been sent — verify tx ${tx.hash} on Basescan before retrying.`,
    );
    (err as any).broadcastTxHash = tx.hash;
    (err as any).originalError = waitErr;
    throw err;
  }

  console.log(`[raffle] refunded ${microUsdc} microUSDC to ${toAddress} tx=${tx.hash}`);
  return tx.hash;
}

export type FailedRaffleRefund = {
  id: string;
  roundId: string;
  identityKey: string;
  wallet: string;
  amountMicroUsdc: number;
  reason: string;
  ts: number;
  broadcastTxHash?: string | null; // present ⇒ verify on Basescan before ever retrying
};

const FAILED_REFUNDS_KEY = "grub:raffle:failed-refunds";

async function recordFailedRefund(entry: Omit<FailedRaffleRefund, "id" | "ts">): Promise<FailedRaffleRefund> {
  const record: FailedRaffleRefund = { ...entry, id: `${entry.roundId}:${entry.identityKey}:${Date.now()}`, ts: Date.now() };
  const list = (await kv.get<FailedRaffleRefund[]>(FAILED_REFUNDS_KEY)) ?? [];
  list.push(record);
  await kv.set(FAILED_REFUNDS_KEY, list);
  console.error(`[raffle] refund FAILED — logged for retry: ${record.id} (${record.reason})`);
  return record;
}

export async function getFailedRefunds(): Promise<FailedRaffleRefund[]> {
  return (await kv.get<FailedRaffleRefund[]>(FAILED_REFUNDS_KEY)) ?? [];
}

/** Keeps a HISTORY_KEY snapshot in sync after a refund lands, so the admin dashboard's history view (which reads from history, not live round records) reflects refund status without a second read path. */
async function updateHistoryEntry(round: RaffleRound) {
  const history = (await kv.get<RaffleRound[]>(HISTORY_KEY)) ?? [];
  const idx = history.findIndex((r) => r.id === round.id);
  if (idx === -1) return;
  history[idx] = round;
  await kv.set(HISTORY_KEY, history);
}

export type RefundResult =
  | { ok: true; txHash: string; amountMicroUsdc: number; wallet: string }
  | { ok: false; reason: string };

/**
 * Refunds one entrant's tickets in a voided round. Idempotent — a second
 * call for the same (roundId, identityKey) short-circuits on round.refunds
 * rather than sending twice. Only works on "void" rounds: resolved rounds
 * had a real draw (refunding would be wrong), and open/awaiting rounds
 * aren't done yet.
 */
export async function refundEntrant(roundId: string, identityKey: string): Promise<RefundResult> {
  const round = await getRound(roundId);
  if (!round) return { ok: false, reason: "round not found" };
  if (round.status !== "void") {
    return { ok: false, reason: `refunds only apply to voided rounds (this round is "${round.status}")` };
  }
  if (round.refunds?.[identityKey]) {
    return { ok: false, reason: "already refunded" };
  }

  const ticketCount = await getTicketCount(roundId, identityKey);
  if (ticketCount <= 0) {
    return { ok: false, reason: "this entrant has no tickets in this round" };
  }
  const amountMicroUsdc = ticketCount * round.ticketPriceMicroUsdc;

  const wallet = await resolveEntrantWallet(identityKey);
  if (!wallet) {
    return { ok: false, reason: "could not resolve a payout wallet for this entrant" };
  }

  // Same lock primitive the referral payouts use — stops a double-click (or
  // a dashboard refresh + re-click race) from sending the refund twice.
  const lockKey = `grub:raffle:refundlock:${roundId}:${identityKey}`;
  const gotLock = await acquireLock(lockKey, 30);
  if (!gotLock) {
    return { ok: false, reason: "a refund for this entrant is already in progress — try again shortly" };
  }

  try {
    let txHash: string;
    try {
      txHash = await sendUsdcFromTreasury(wallet, amountMicroUsdc);
    } catch (err: any) {
      console.error("[raffle] refundEntrant sendUsdcFromTreasury failed:", err);
      await recordFailedRefund({
        roundId,
        identityKey,
        wallet,
        amountMicroUsdc,
        reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error",
        broadcastTxHash: err?.broadcastTxHash ?? null,
      });
      return {
        ok: false,
        reason:
          "USDC refund failed to send — logged in the failed-refunds list for retry. If a tx hash was broadcast, verify it on Basescan before retrying to avoid a double-refund.",
      };
    }

    // Re-fetch fresh before writing back — refunding a DIFFERENT entrant in
    // this same round concurrently also writes this key, so reading right
    // before the write (rather than reusing the `round` fetched at the top
    // of this function) avoids clobbering their refund entry.
    const fresh = (await getRound(roundId)) ?? round;
    const updated: RaffleRound = {
      ...fresh,
      refunds: { ...(fresh.refunds ?? {}), [identityKey]: { txHash, amountMicroUsdc, wallet, refundedAt: Date.now() } },
    };
    await kv.set(roundKey(roundId), updated);
    await updateHistoryEntry(updated);

    console.log(`[raffle] refunded ${amountMicroUsdc} microUSDC to ${wallet} (round ${roundId}, ${identityKey}) tx=${txHash}`);
    return { ok: true, txHash, amountMicroUsdc, wallet };
  } finally {
    await releaseLock(lockKey);
  }
}
