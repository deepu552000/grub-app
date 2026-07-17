// lib/minigames.ts
//
// Backend for Grub's mini-games block. First game: Coin Toss.
//
// Design (see chat plan): players bet from an INTERNAL DEGEN balance, not
// their real wallet — nothing on-chain happens per flip. Real DEGEN only
// moves when they cash out, same treasury/sendDegen() the raffle's degen
// prize and referral payouts already use. This keeps the treasury key out
// of the hot path of an automated, unattended, per-flip payout — the
// riskiest part of a real-money instant game — while still feeling instant
// to the player (their in-app balance updates immediately).
//
// Randomization is a plain server-side crypto.randomBytes() 50/50 split for
// v1 (not provably-fair) — every flip is logged so win-rate is auditable in
// aggregate even without cryptographic proof. Can upgrade to a commit-reveal
// scheme later without changing the balance/config model below.

import { randomBytes, createHash, createHmac } from "crypto";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { acquireLock, releaseLock, sendDegen } from "@/lib/referral";

// ── Treasury balance read (for the max-bet-as-%-of-treasury guard) ─────────
// Deliberately a self-contained copy of the balance-read pattern in
// app/api/referral/pool/route.ts rather than a shared import — that route is
// small and stable; duplicating ~10 lines here avoids coupling this file's
// deploy to that route's.
const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // DEGEN on Base
const DEGEN_ABI = ["function balanceOf(address owner) view returns (uint256)"];

async function getTreasuryDegenBalance(): Promise<number> {
  const treasury = process.env.TREASURY_WALLET_ADDRESS ?? "";
  if (!treasury) return 0;
  try {
    const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_BASE_RPC_URL ?? "https://mainnet.base.org");
    const contract = new ethers.Contract(DEGEN_CONTRACT, DEGEN_ABI, provider);
    const raw: bigint = await contract.balanceOf(treasury);
    return Number(ethers.formatUnits(raw, 18));
  } catch (err) {
    console.error("[minigames] getTreasuryDegenBalance failed:", err);
    return 0;
  }
}

// ── Config ───────────────────────────────────────────────────────────────
export type CoinTossConfig = {
  enabled: boolean;
  minBetDegen: number;
  maxBetDegen: number;
  feePercentOnWin: number; // e.g. 10 → winner keeps 90% of the profit portion
  maxBetPercentOfTreasury: number; // e.g. 3 → bet also capped at 3% of live treasury, whichever is lower
  lossCircuitBreakerDegen: number; // rolling 24h net house loss before auto-pause
  maxFlipsPerMinutePerUser: number;
  autoCashoutMaxDegen: number; // cash-outs at/under this send immediately; above this go to the admin queue
  seedRotateAfterFlips: number; // provably-fair seed auto-rotates once it's backed this many flips
};

const DEFAULT_CONFIG: CoinTossConfig = {
  enabled: true,
  minBetDegen: 10,
  maxBetDegen: 50,
  feePercentOnWin: 10,
  maxBetPercentOfTreasury: 3,
  lossCircuitBreakerDegen: 500,
  maxFlipsPerMinutePerUser: 10,
  autoCashoutMaxDegen: 50,
  seedRotateAfterFlips: 100,
};

const CONFIG_KEY = "grub:minigames:cointoss:config";

export async function getCoinTossConfig(): Promise<CoinTossConfig> {
  const stored = await kv.get<Partial<CoinTossConfig>>(CONFIG_KEY);
  // Merge over defaults so adding a new config field later doesn't require
  // a migration — old stored objects just pick up the new default.
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export async function setCoinTossConfig(patch: Partial<CoinTossConfig>): Promise<CoinTossConfig> {
  const current = await getCoinTossConfig();
  const updated = { ...current, ...patch };
  await kv.set(CONFIG_KEY, updated);
  return updated;
}

// ── Internal balance ─────────────────────────────────────────────────────
function balanceKey(identityKey: string) {
  return `grub:minigames:balance:${identityKey}`;
}

export async function getBalance(identityKey: string): Promise<number> {
  return (await kv.get<number>(balanceKey(identityKey))) ?? 0;
}

async function adjustBalance(identityKey: string, delta: number): Promise<number> {
  const current = await getBalance(identityKey);
  const next = Math.max(0, current + delta);
  await kv.set(balanceKey(identityKey), next);
  return next;
}

// ── Manual credit log (admin top-ups) ───────────────────────────────────
export type CreditHistoryEntry = {
  id: string;
  identityKey: string;
  amountDegen: number;
  reason: string;
  newBalance: number;
  ts: number;
  cancelled?: boolean;
  cancelledAt?: number;
};

const CREDIT_HISTORY_KEY = "grub:minigames:credithistory";
const MAX_LOGGED_CREDITS = 200; // trim so this key doesn't grow unbounded

async function logCredit(entry: CreditHistoryEntry) {
  const list = (await kv.get<CreditHistoryEntry[]>(CREDIT_HISTORY_KEY)) ?? [];
  list.unshift(entry);
  if (list.length > MAX_LOGGED_CREDITS) list.length = MAX_LOGGED_CREDITS;
  await kv.set(CREDIT_HISTORY_KEY, list);
}

export async function getCreditHistory(limit = 50): Promise<CreditHistoryEntry[]> {
  const list = (await kv.get<CreditHistoryEntry[]>(CREDIT_HISTORY_KEY)) ?? [];
  return list.slice(0, limit);
}

/**
 * Admin-only top-up — the only way DEGEN gets INTO a player's internal
 * balance today is this, or a raffle DEGEN prize being routed here instead
 * of straight on-chain (your call later). Kept separate from adjustBalance
 * so every credit that isn't a game outcome is deliberate and logged.
 */
export async function creditBalance(identityKey: string, amountDegen: number, reason: string): Promise<number> {
  const next = await adjustBalance(identityKey, amountDegen);
  console.log(`[minigames] credited ${amountDegen} DEGEN to ${identityKey} (${reason}) — new balance ${next}`);
  await logCredit({
    id: randomBytes(8).toString("hex"),
    identityKey,
    amountDegen,
    reason,
    newBalance: next,
    ts: Date.now(),
  });
  return next;
}

/**
 * Reverses a manual top-up — pulls the same amount back out of the
 * player's internal balance and marks the log entry as cancelled so the
 * admin dashboard can grey it out instead of re-showing a "Cancel" button.
 * Only ever touches entries created by creditBalance() above; never used
 * for game-outcome balance changes.
 */
export async function cancelCredit(creditId: string): Promise<
  { ok: true; identityKey: string; newBalance: number } | { ok: false; reason: string }
> {
  const list = (await kv.get<CreditHistoryEntry[]>(CREDIT_HISTORY_KEY)) ?? [];
  const entry = list.find((c) => c.id === creditId);
  if (!entry) return { ok: false, reason: "credit entry not found" };
  if (entry.cancelled) return { ok: false, reason: "already cancelled" };

  // Guard against reversing a credit whose funds have already moved on —
  // spent on a bet, cashed out, etc. Without this, adjustBalance's
  // Math.max(0, ...) floor would silently zero out whatever balance is
  // left (which may include unrelated winnings or other credits) instead
  // of accurately reversing just this one credit. If less than the
  // credited amount remains, there's nothing logically correct to cancel.
  const currentBalance = await getBalance(entry.identityKey);
  if (currentBalance < entry.amountDegen) {
    return {
      ok: false,
      reason: `Can't cancel — only ${currentBalance} DEGEN of the ${entry.amountDegen} credited remains; the rest has already been spent or cashed out.`,
    };
  }

  const newBalance = await adjustBalance(entry.identityKey, -entry.amountDegen);
  entry.cancelled = true;
  entry.cancelledAt = Date.now();
  await kv.set(CREDIT_HISTORY_KEY, list);

  console.log(`[minigames] cancelled credit ${creditId} — reversed ${entry.amountDegen} DEGEN from ${entry.identityKey}, new balance ${newBalance}`);
  return { ok: true, identityKey: entry.identityKey, newBalance };
}

// ── On-chain DEGEN deposits ──────────────────────────────────────────────
// Player sends real DEGEN directly to the treasury wallet — same address
// and same client-side send flow (sendDegenDeposit in Client.tsx) as the
// USDC checkin/accessory payments already use, just a different
// contract/decimals. This is the missing counterpart to creditBalance()
// above: that one is admin-only; this is the player-initiated top-up path.
const DEGEN_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

function usedTxKey(txHash: string) {
  return `grub:minigames:usedtx:${txHash.toLowerCase()}`;
}

/**
 * Confirms a DEGEN Transfer(from, treasury, value) log exists in the given
 * tx's receipt, and that the transferred amount is >= claimedAmount (">="
 * rather than "===" so float rounding in the client's calldata build can
 * never cause an honest deposit to fail verification — the tiniest bit of
 * dust in the player's favor is harmless). Returns the ACTUAL on-chain
 * amount, not the claimed one, so callers always credit exactly what
 * really arrived.
 */
async function verifyDegenDeposit(
  txHash: string,
  claimedAmount: number,
): Promise<{ ok: true; amount: number; from: string } | { ok: false; reason: string }> {
  const treasury = (process.env.TREASURY_WALLET_ADDRESS ?? "").toLowerCase();
  if (!treasury) return { ok: false, reason: "treasury wallet not configured" };

  try {
    const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_BASE_RPC_URL ?? "https://mainnet.base.org");
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return { ok: false, reason: "transaction not found — it may not be mined yet, try again shortly" };
    if (receipt.status !== 1) return { ok: false, reason: "transaction failed on-chain" };

    const iface = new ethers.Interface(DEGEN_TRANSFER_ABI);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== DEGEN_CONTRACT.toLowerCase()) continue;
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue; // not a Transfer log (or not decodable against this ABI) — skip
      }
      if (!parsed || parsed.name !== "Transfer") continue;
      if ((parsed.args.to as string).toLowerCase() !== treasury) continue;

      const amount = Number(ethers.formatUnits(parsed.args.value as bigint, 18));
      if (amount + 1e-9 < claimedAmount) {
        return { ok: false, reason: `on-chain amount (${amount}) is less than claimed (${claimedAmount})` };
      }
      return { ok: true, amount, from: (parsed.args.from as string).toLowerCase() };
    }
    return { ok: false, reason: "no matching DEGEN transfer to the treasury found in this transaction" };
  } catch (err: any) {
    console.error("[minigames] verifyDegenDeposit failed:", err);
    return { ok: false, reason: err?.message ?? "verification error" };
  }
}

/**
 * Writes a "minigame_deposit" entry into the same txn-log KV lists that
 * logCashoutTxn (above) and app/api/txn-log/route.ts's POST handler write
 * to. Deposits are the mirror image of cash-outs — real DEGEN moving
 * on-chain — so they get the same treatment: without this they'd have the
 * identical "missing from the Transaction Log" gap that cash-outs just got
 * fixed for.
 */
async function logDepositTxn(identityKey: string, amountDegen: number, txHash: string) {
  const entry = {
    fid: identityKey,
    type: "minigame_deposit" as const,
    txHash,
    amountUsd: 0, // internal-balance DEGEN deposit, no USD leg tracked here
    amountDegen,
    ts: Date.now(),
  };

  try {
    const userKey = `txn-log:${identityKey}`;
    const userLog = (await kv.get<any[]>(userKey)) ?? [];
    userLog.push(entry);
    if (userLog.length > 200) userLog.splice(0, userLog.length - 200);
    await kv.set(userKey, userLog);

    const globalKey = "txn-log:all";
    const globalLog = (await kv.get<any[]>(globalKey)) ?? [];
    globalLog.push(entry);
    if (globalLog.length > 1000) globalLog.splice(0, globalLog.length - 1000);
    await kv.set(globalKey, globalLog);
  } catch (err) {
    // Never let a logging failure block or roll back a deposit that already
    // landed on-chain and was already credited — just surface it loudly.
    console.error("[minigames] logDepositTxn failed:", err);
  }
}

export type DepositResult =
  | { ok: true; creditedDegen: number; newBalance: number }
  | { ok: false; reason: string };

// Per-identity deposit history — mirrors PendingCashout/CASHOUTS_KEY's shape
// and access pattern (unshift newest-first, slice for "last N") so the UI's
// "recent deposits" block can work exactly like "recent cash-outs" does.
export type DegenDeposit = {
  id: string;
  identityKey: string;
  amountDegen: number;
  txHash: string;
  ts: number;
};

const DEPOSITS_KEY = "grub:minigames:cointoss:deposits";
const MAX_LOGGED_DEPOSITS = 1000; // trim so this key doesn't grow unbounded

async function getAllDeposits(): Promise<DegenDeposit[]> {
  return (await kv.get<DegenDeposit[]>(DEPOSITS_KEY)) ?? [];
}

/**
 * A player's own deposit history (most recent first) — same "safe to
 * return in full, it's the caller's own data" reasoning as
 * getCashoutsForIdentity, and used the same way: to render a "last 5
 * deposits" block next to the existing "last 5 cash-outs" one.
 */
export async function getDepositsForIdentity(identityKey: string, limit = 5): Promise<DegenDeposit[]> {
  return (await getAllDeposits()).filter((d) => d.identityKey === identityKey).slice(0, limit);
}

/**
 * Credits a player's internal Coin Toss balance from a real on-chain DEGEN
 * deposit to the treasury wallet, after verifying it actually happened.
 *
 * Replay-guarded with a one-time KV claim on txHash (NX-set, 30-day TTL) —
 * the same idea as the "grub:used-tx:<hash>" guard other payment routes use
 * — so the identical transaction can never credit a balance twice, whether
 * from a client retry or a repeated POST. If verification then fails (tx
 * not yet mined, wrong recipient, etc.) the claim is released so a
 * legitimate retry once the tx actually confirms isn't permanently blocked.
 */
export async function depositDegen(
  identityKey: string,
  txHash: string,
  claimedAmount: number,
): Promise<DepositResult> {
  if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
    return { ok: false, reason: "invalid transaction hash" };
  }
  if (!Number.isFinite(claimedAmount) || claimedAmount <= 0) {
    return { ok: false, reason: "invalid deposit amount" };
  }

  const claimKey = usedTxKey(txHash);
  const claimed = await kv.set(claimKey, identityKey, { nx: true, ex: 60 * 60 * 24 * 30 } as any);
  if (claimed === null) {
    return { ok: false, reason: "This transaction was already used to credit a balance." };
  }

  const verified = await verifyDegenDeposit(txHash, claimedAmount);
  if (!verified.ok) {
    await kv.del(claimKey);
    return { ok: false, reason: verified.reason };
  }

  const newBalance = await adjustBalance(identityKey, verified.amount);
  console.log(`[minigames] deposit credited ${verified.amount} DEGEN to ${identityKey} (tx ${txHash}) — new balance ${newBalance}`);
  await logCredit({
    id: randomBytes(8).toString("hex"),
    identityKey,
    amountDegen: verified.amount,
    reason: `on-chain deposit (tx ${txHash})`,
    newBalance,
    ts: Date.now(),
  });
  await logDepositTxn(identityKey, verified.amount, txHash);

  // Record into the per-identity deposit list — this is what was missing
  // for the "recent deposits" UI block; logDepositTxn above only wrote to
  // the global Transaction Log, which the player-facing panel doesn't read.
  const depositList = await getAllDeposits();
  depositList.unshift({
    id: randomBytes(8).toString("hex"),
    identityKey,
    amountDegen: verified.amount,
    txHash,
    ts: Date.now(),
  });
  if (depositList.length > MAX_LOGGED_DEPOSITS) depositList.length = MAX_LOGGED_DEPOSITS;
  await kv.set(DEPOSITS_KEY, depositList);

  return { ok: true, creditedDegen: verified.amount, newBalance };
}


// ── Flip log + rolling P&L ───────────────────────────────────────────────
export type CoinTossFlip = {
  id: string;
  identityKey: string;
  betDegen: number;
  choice: "heads" | "tails";
  result: "heads" | "tails";
  won: boolean;
  payoutDegen: number; // 0 if lost
  feeTakenDegen: number; // 0 if lost
  ts: number;
  // Provably-fair proof data for this specific flip — recorded even
  // though there's no verify UI yet, so nothing needs backfilling when
  // one gets built. serverSeedHash is the PUBLIC commitment (safe to show
  // immediately); the raw serverSeed itself is only ever exposed once
  // rotated out, via the seed history — see rotateServerSeed() below.
  serverSeedHash: string;
  nonce: number;
  clientSeed: string;
};

const FLIPS_KEY = "grub:minigames:cointoss:flips";
const MAX_LOGGED_FLIPS = 500; // trim so this key doesn't grow unbounded — global, all-players window

async function logFlip(flip: CoinTossFlip) {
  const list = (await kv.get<CoinTossFlip[]>(FLIPS_KEY)) ?? [];
  list.unshift(flip);
  if (list.length > MAX_LOGGED_FLIPS) list.length = MAX_LOGGED_FLIPS;
  await kv.set(FLIPS_KEY, list);
}

export async function getRecentFlips(limit = 20): Promise<CoinTossFlip[]> {
  const list = (await kv.get<CoinTossFlip[]>(FLIPS_KEY)) ?? [];
  return list.slice(0, limit);
}

// ── Per-player flip history ─────────────────────────────────────────────
// Own key per identity, capped at MAX_LOGGED_FLIPS_PER_PLAYER each. This is
// separate from the shared FLIPS_KEY above (which stays a single 500-flip
// window across every player combined, feeding the admin Fairness panel's
// "recent flips" feed). Before this, getFlipsForIdentity() filtered that
// same shared list down to one identity — meaning a busy site could push a
// quiet player's flips out of the window entirely even though *they*
// hadn't flipped 500 times. Storing per-identity means each player gets
// their own full 500-flip window regardless of how active anyone else is.
const MAX_LOGGED_FLIPS_PER_PLAYER = 500;

function identityFlipsKey(identityKey: string) {
  return `grub:minigames:cointoss:flips:${identityKey}`;
}

async function logFlipForIdentity(identityKey: string, flip: CoinTossFlip) {
  const key = identityFlipsKey(identityKey);
  const list = (await kv.get<CoinTossFlip[]>(key)) ?? [];
  list.unshift(flip);
  if (list.length > MAX_LOGGED_FLIPS_PER_PLAYER) list.length = MAX_LOGGED_FLIPS_PER_PLAYER;
  await kv.set(key, list);
}

/**
 * A single player's own flip history (most recent first), read from their
 * own per-identity key — not affected by other players' activity.
 */
export async function getFlipsForIdentity(identityKey: string, limit = 20): Promise<CoinTossFlip[]> {
  const list = (await kv.get<CoinTossFlip[]>(identityFlipsKey(identityKey))) ?? [];
  return list.slice(0, limit);
}

// ── Per-player running totals (all-time, never trimmed) ─────────────────
// Unlike the flip logs above, this is a single small counter object per
// identity that gets incremented on every flip — never rebuilt by
// filtering/reducing a stored list, so it can't lose history to a trim.
// This is what player-facing and admin P/L numbers should read from.
export type CoinTossTotals = {
  flips: number;
  wins: number;
  totalWagered: number; // sum of every bet placed, all-time
  betOnWins: number; // sum of betDegen on winning flips only, all-time
  totalWon: number; // sum of payoutDegen on winning flips, all-time
  totalLost: number; // sum of betDegen on losing flips, all-time
  lastPlayedAt: number;
};

function totalsKey(identityKey: string) {
  return `grub:minigames:cointoss:totals:${identityKey}`;
}

async function bumpPlayerTotals(identityKey: string, flip: CoinTossFlip): Promise<CoinTossTotals> {
  const key = totalsKey(identityKey);
  const current = (await kv.get<CoinTossTotals>(key)) ?? {
    flips: 0,
    wins: 0,
    totalWagered: 0,
    betOnWins: 0,
    totalWon: 0,
    totalLost: 0,
    lastPlayedAt: 0,
  };
  current.flips += 1;
  current.totalWagered += flip.betDegen;
  current.lastPlayedAt = flip.ts;
  if (flip.won) {
    current.wins += 1;
    current.betOnWins += flip.betDegen;
    current.totalWon += flip.payoutDegen;
  } else {
    current.totalLost += flip.betDegen;
  }
  await kv.set(key, current);
  return current;
}

// ── Index of every identity that's ever placed a flip ───────────────────
// getAllCoinTossPlayerStats() used to derive its player list by scanning
// the shared FLIPS_KEY window — so a player who hadn't flipped recently
// could silently drop out of the Player Stats table once enough other
// activity pushed them out of the last 500. This index is append-only and
// never trimmed, so once someone's played once they always show up.
const IDENTITIES_KEY = "grub:minigames:cointoss:identities";

async function trackIdentity(identityKey: string) {
  const list = (await kv.get<string[]>(IDENTITIES_KEY)) ?? [];
  if (!list.includes(identityKey)) {
    list.push(identityKey);
    await kv.set(IDENTITIES_KEY, list);
  }
}

// ── House-level running totals (all-time, never trimmed) ────────────────
// Same idea as the per-player totals above, one level up — a single small
// counter object bumped on every flip, instead of the "all-time" stats
// being derived by reducing over the shared FLIPS_KEY window (which is
// capped at MAX_LOGGED_FLIPS and therefore isn't actually all-time once
// the site passes that many total flips). This is what getCoinTossStats()
// should read for its allTime block.
export type CoinTossHouseTotals = {
  flips: number;
  wins: number;
  totalWagered: number;
  totalPaidOut: number;
};

const HOUSE_TOTALS_KEY = "grub:minigames:cointoss:house_totals";

async function bumpHouseTotals(flip: CoinTossFlip): Promise<CoinTossHouseTotals> {
  const current = (await kv.get<CoinTossHouseTotals>(HOUSE_TOTALS_KEY)) ?? {
    flips: 0,
    wins: 0,
    totalWagered: 0,
    totalPaidOut: 0,
  };
  current.flips += 1;
  current.totalWagered += flip.betDegen;
  current.totalPaidOut += flip.payoutDegen;
  if (flip.won) current.wins += 1;
  await kv.set(HOUSE_TOTALS_KEY, current);
  return current;
}

/**
 * Records a resolved flip everywhere it needs to live: the shared 500-flip
 * admin feed, the player's own 500-flip history, their permanent running
 * totals, the house-wide permanent totals, and (if new) the all-time
 * identity index.
 */
async function recordFlip(identityKey: string, flip: CoinTossFlip) {
  await Promise.all([
    logFlip(flip),
    logFlipForIdentity(identityKey, flip),
    bumpPlayerTotals(identityKey, flip),
    bumpHouseTotals(flip),
    trackIdentity(identityKey),
  ]);
}

/**
 * Clears just the WIN/LOSS FLIP HISTORY for one identity — their shared-log
 * flip entries, their per-identity flip log, their permanent totals
 * (flips/wins/totalWagered/betOnWins/totalWon/totalLost), this identity's
 * contribution to the house-wide totals, and their entry in the identity
 * index (so they drop out of the Player Stats table entirely once they
 * have zero flips, same "played only" rule that table already follows).
 *
 * Deliberately does NOT touch: internal balance, deposits, cash-outs,
 * manual credit history, or client seed — those are real actions/money
 * movements, not fabricated bet outcomes, and should survive a test-data
 * cleanup like this untouched. Use this for test/dev identities whose
 * flip win/loss numbers were never meant to count.
 *
 * Does not adjust the rolling-24h house P&L buckets — those age out within
 * 24h on their own, so this is only meaningful for flips still inside that
 * window. If you're clearing flips from the last 24h, the "last 24h" card
 * on the dashboard will look slightly off until that window rolls past
 * them naturally.
 */
export async function purgeCoinTossFlipHistory(identityKey: string): Promise<{ flipsRemoved: number }> {
  const [globalFlips, myFlips, houseTotals] = await Promise.all([
    kv.get<CoinTossFlip[]>(FLIPS_KEY),
    kv.get<CoinTossFlip[]>(identityFlipsKey(identityKey)),
    kv.get<CoinTossHouseTotals>(HOUSE_TOTALS_KEY),
  ]);

  // Union of both stores (by flip id) so the house-totals subtraction is
  // correct even if the two logs have drifted apart for any reason.
  const removed = new Map<string, CoinTossFlip>();
  for (const f of globalFlips ?? []) if (f.identityKey === identityKey) removed.set(f.id, f);
  for (const f of myFlips ?? []) if (f.identityKey === identityKey) removed.set(f.id, f);
  const removedFlips = [...removed.values()];

  const remainingGlobal = (globalFlips ?? []).filter((f) => f.identityKey !== identityKey);

  const ops: Promise<any>[] = [
    kv.set(FLIPS_KEY, remainingGlobal),
    kv.del(identityFlipsKey(identityKey)),
    kv.del(totalsKey(identityKey)),
  ];

  const list = (await kv.get<string[]>(IDENTITIES_KEY)) ?? [];
  if (list.includes(identityKey)) {
    ops.push(kv.set(IDENTITIES_KEY, list.filter((id) => id !== identityKey)));
  }

  if (houseTotals && removedFlips.length > 0) {
    const wins = removedFlips.filter((f) => f.won).length;
    const totalWagered = removedFlips.reduce((sum, f) => sum + f.betDegen, 0);
    const totalPaidOut = removedFlips.reduce((sum, f) => sum + f.payoutDegen, 0);
    const adjusted: CoinTossHouseTotals = {
      flips: Math.max(0, houseTotals.flips - removedFlips.length),
      wins: Math.max(0, houseTotals.wins - wins),
      totalWagered: Math.max(0, houseTotals.totalWagered - totalWagered),
      totalPaidOut: Math.max(0, houseTotals.totalPaidOut - totalPaidOut),
    };
    ops.push(kv.set(HOUSE_TOTALS_KEY, adjusted));
  }

  await Promise.all(ops);
  return { flipsRemoved: removedFlips.length };
}

function hourBucketKey(ts: number) {
  const hour = Math.floor(ts / (60 * 60 * 1000));
  return `grub:minigames:cointoss:pnl:${hour}`;
}

async function recordPnl(ts: number, wagered: number, paidOut: number) {
  const key = hourBucketKey(ts);
  const existing = (await kv.get<{ wagered: number; paidOut: number }>(key)) ?? { wagered: 0, paidOut: 0 };
  const updated = { wagered: existing.wagered + wagered, paidOut: existing.paidOut + paidOut };
  // 48h TTL — plenty of margin over the 24h window we actually read.
  await kv.set(key, updated, { ex: 60 * 60 * 48 });
  return updated;
}

/** Sums the last 24 hourly buckets. House net = wagered − paidOut (positive = house is up). */
export async function getRolling24hPnl(): Promise<{ wagered: number; paidOut: number; houseNet: number }> {
  const now = Date.now();
  let wagered = 0;
  let paidOut = 0;
  for (let i = 0; i < 24; i++) {
    const bucket = await kv.get<{ wagered: number; paidOut: number }>(hourBucketKey(now - i * 60 * 60 * 1000));
    if (bucket) {
      wagered += bucket.wagered;
      paidOut += bucket.paidOut;
    }
  }
  return { wagered, paidOut, houseNet: wagered - paidOut };
}

const ALERTS_KEY = "grub:minigames:cointoss:alerts";
export type CoinTossAlert = { id: string; message: string; ts: number };

async function pushAlert(message: string) {
  const list = (await kv.get<CoinTossAlert[]>(ALERTS_KEY)) ?? [];
  list.unshift({ id: `${Date.now()}`, message, ts: Date.now() });
  if (list.length > 50) list.length = 50;
  await kv.set(ALERTS_KEY, list);
  console.error(`[minigames] ALERT: ${message}`);
}

export async function getAlerts(): Promise<CoinTossAlert[]> {
  return (await kv.get<CoinTossAlert[]>(ALERTS_KEY)) ?? [];
}

// ── Provably-fair RNG (commit-reveal) ───────────────────────────────────
// Casino-standard scheme, phase 1 (server side only — no player-facing
// verify UI yet, see clientSeed note below):
//
//   1. The server commits to a random 32-byte seed BEFORE any flips use
//      it — only its SHA-256 hash (serverSeedHash) is ever exposed while
//      it's active, never the raw seed itself.
//   2. Every flip resolved against that seed is deterministic:
//      HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), with nonce
//      incrementing once per flip so the same input never repeats.
//   3. When the seed rotates, the raw serverSeed is finally revealed into
//      seedHistory — at that point anyone can recompute every flip that
//      used it and confirm (a) hash(serverSeed) matches the hash that was
//      committed beforehand, and (b) each flip's HMAC output matches its
//      recorded result. This is what proves the server couldn't have
//      picked a favorable outcome after seeing the bet — the commitment
//      existed first.
//
// This replaces the previous single `randomBytes(1)[0] % 2`. That was
// already a cryptographically secure, unbiased coin (not fixable, wasn't
// broken) — the actual gap "how casinos do it" was closing was
// auditability: nothing about the old scheme let anyone independently
// verify after the fact that a result wasn't chosen after the bet came
// in. Commit-reveal closes that gap regardless of RNG quality.
//
// clientSeed is now a real per-player value, not a shared placeholder —
// see getOrCreateClientSeed() below. It's generated once per identity on
// their first-ever flip and then reused for every flip after that (same
// "persist forever, no expiry" pattern as the balance) — there's no
// regenerate UI yet (that's still phase 2: a "Provably Fair" panel where
// the player can see/rotate their own seed), so for now this only closes
// the "server knows the client seed in advance" gap, not the "player can
// refresh it themselves" one. Recording clientSeed per-flip (see
// CoinTossFlip type above) means adding that regenerate control later
// doesn't require touching any already-settled flip — each one already
// carries whatever clientSeed was actually used against it.
function clientSeedKey(identityKey: string) {
  return `grub:minigames:cointoss:clientseed:${identityKey}`;
}

export async function getOrCreateClientSeed(identityKey: string): Promise<string> {
  const existing = await kv.get<string>(clientSeedKey(identityKey));
  if (existing) return existing;
  const fresh = randomBytes(16).toString("hex");
  await kv.set(clientSeedKey(identityKey), fresh);
  return fresh;
}

type ActiveSeed = {
  serverSeed: string; // raw — SECRET while active, revealed only on rotation
  serverSeedHash: string; // sha256(serverSeed) — safe to expose anytime
  nonce: number; // increments once per flip resolved against this seed
  createdAt: number;
};

type RevealedSeed = {
  serverSeed: string;
  serverSeedHash: string;
  finalNonce: number; // how many flips used this seed before it rotated
  createdAt: number;
  revealedAt: number;
};

const ACTIVE_SEED_KEY = "grub:minigames:cointoss:activeseed";
const SEED_HISTORY_KEY = "grub:minigames:cointoss:seedhistory";
const MAX_LOGGED_SEEDS = 200;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Rotates the active server seed: reveals the outgoing one (if any) into
 * seedHistory — safe the moment it's no longer being used for new flips —
 * then mints and commits a fresh one. Exported (not called anywhere yet
 * outside this file) so a future scheduled rotation or admin action can
 * call it directly without any further backend changes.
 */
export async function rotateServerSeed(): Promise<ActiveSeed> {
  const existing = await kv.get<ActiveSeed>(ACTIVE_SEED_KEY);
  if (existing) {
    const history = (await kv.get<RevealedSeed[]>(SEED_HISTORY_KEY)) ?? [];
    history.unshift({
      serverSeed: existing.serverSeed,
      serverSeedHash: existing.serverSeedHash,
      finalNonce: existing.nonce,
      createdAt: existing.createdAt,
      revealedAt: Date.now(),
    });
    if (history.length > MAX_LOGGED_SEEDS) history.length = MAX_LOGGED_SEEDS;
    await kv.set(SEED_HISTORY_KEY, history);
    console.log(`[minigames] rotated Coin Toss server seed — outgoing seed used for ${existing.nonce} flips, now revealed`);
  }

  const fresh: ActiveSeed = {
    serverSeed: randomBytes(32).toString("hex"),
    serverSeedHash: "", // set below
    nonce: 0,
    createdAt: Date.now(),
  };
  fresh.serverSeedHash = sha256Hex(fresh.serverSeed);
  await kv.set(ACTIVE_SEED_KEY, fresh);
  return fresh;
}

async function getOrCreateActiveSeed(): Promise<ActiveSeed> {
  const existing = await kv.get<ActiveSeed>(ACTIVE_SEED_KEY);
  if (existing) return existing;
  return rotateServerSeed(); // no active seed yet (first-ever flip) — mint one
}

/**
 * Deterministically resolves one flip against the active seed and
 * increments its nonce. The HMAC's first 4 bytes are read as a uint32
 * and reduced mod 2 — HMAC-SHA256 output is uniformly random per bit, so
 * a power-of-two modulus (2) on it introduces no bias; the "reroll bias
 * near the range edge" correction some games need only applies to
 * non-power-of-two ranges (e.g. picking 1–37 for roulette), not a coin.
 */
async function resolveFlipOutcome(identityKey: string): Promise<{
  result: "heads" | "tails";
  serverSeedHash: string;
  nonce: number;
  clientSeed: string;
}> {
  const active = await getOrCreateActiveSeed();
  const nonce = active.nonce;
  const clientSeed = await getOrCreateClientSeed(identityKey);

  const hmac = createHmac("sha256", active.serverSeed).update(`${clientSeed}:${nonce}`).digest("hex");
  const int = parseInt(hmac.slice(0, 8), 16);
  const result: "heads" | "tails" = int % 2 === 0 ? "heads" : "tails";

  await kv.set(ACTIVE_SEED_KEY, { ...active, nonce: nonce + 1 });
  return { result, serverSeedHash: active.serverSeedHash, nonce, clientSeed };
}

// ── Admin seed view ──────────────────────────────────────────────────────
// For the admin dashboard's new "Provably Fair" panel. Two different
// trust levels on purpose:
//
//   getActiveSeedSummary() — safe to show while the seed is still LIVE.
//   Only the hash + how many flips have used it + when it was minted.
//   Never the raw serverSeed itself: that's the thing the whole scheme
//   depends on staying secret until rotation, so exposing it early would
//   let anyone precompute every future flip against it.
//
//   getSeedHistory() — the raw serverSeed for seeds that have ALREADY
//   rotated out. Safe in full: once revealed, a seed is done being used
//   for new flips forever, so there's nothing left to protect. This is
//   what actually lets you (or anyone) verify: recompute sha256(seed) and
//   confirm it equals the hash that was committed the whole time it was
//   active, then recompute any flip's HMAC and confirm it matches what
//   was paid out.
export async function getActiveSeedSummary(): Promise<{ serverSeedHash: string; flipsUsed: number; createdAt: number } | null> {
  const active = await kv.get<ActiveSeed>(ACTIVE_SEED_KEY);
  if (!active) return null;
  return { serverSeedHash: active.serverSeedHash, flipsUsed: active.nonce, createdAt: active.createdAt };
}

export async function getSeedHistory(limit = 20): Promise<RevealedSeed[]> {
  const history = (await kv.get<RevealedSeed[]>(SEED_HISTORY_KEY)) ?? [];
  return history.slice(0, limit);
}

// ── Rate limiting ────────────────────────────────────────────────────────
async function checkRateLimit(identityKey: string, maxPerMinute: number): Promise<boolean> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `grub:minigames:cointoss:ratelimit:${identityKey}:${minuteBucket}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, 70); // auto-clean, only set once per bucket
  return count <= maxPerMinute;
}

// ── Placing a bet ────────────────────────────────────────────────────────
export type PlaceBetResult =
  | {
      ok: true;
      result: "heads" | "tails";
      won: boolean;
      payoutDegen: number;
      feeTakenDegen: number;
      newBalance: number;
      // Provably-fair proof for THIS flip — same values logged in
      // CoinTossFlip, returned here too so the client can show a "🔒 Fair"
      // tag right on the result without a second fetch. serverSeedHash is
      // just the public commitment (safe pre-reveal); nonce + clientSeed
      // are what let a player later recompute this exact flip once the
      // seed rotates and its raw value is revealed.
      serverSeedHash: string;
      nonce: number;
      clientSeed: string;
    }
  | { ok: false; reason: string };

export async function placeCoinTossBet(
  identityKey: string,
  betDegen: number,
  choice: "heads" | "tails",
): Promise<PlaceBetResult> {
  const config = await getCoinTossConfig();

  if (!config.enabled) {
    return { ok: false, reason: "Coin Toss is paused right now — check back soon." };
  }
  if (choice !== "heads" && choice !== "tails") {
    return { ok: false, reason: "choice must be heads or tails" };
  }
  if (!Number.isFinite(betDegen) || betDegen <= 0) {
    return { ok: false, reason: "invalid bet amount" };
  }
  if (betDegen < config.minBetDegen || betDegen > config.maxBetDegen) {
    return { ok: false, reason: `Bet must be between ${config.minBetDegen} and ${config.maxBetDegen} DEGEN.` };
  }

  // Bet is also capped at a % of live treasury, whichever is lower than
  // maxBetDegen — so if the treasury shrinks, the effective max shrinks
  // with it automatically, independent of whatever maxBetDegen is set to.
  const treasuryBalance = await getTreasuryDegenBalance();
  const treasuryCap = treasuryBalance * (config.maxBetPercentOfTreasury / 100);
  if (treasuryBalance > 0 && betDegen > treasuryCap) {
    return { ok: false, reason: "Bet exceeds the current treasury-based max — try a smaller amount." };
  }

  const underRateLimit = await checkRateLimit(identityKey, config.maxFlipsPerMinutePerUser);
  if (!underRateLimit) {
    return { ok: false, reason: "Slow down — too many flips this minute, try again shortly." };
  }

  const balance = await getBalance(identityKey);
  if (balance < betDegen) {
    return { ok: false, reason: "Not enough DEGEN balance for that bet." };
  }

  // Deduct the stake up front, then resolve — matches the "verify → write"
  // ordering used elsewhere in this codebase, just without an on-chain leg.
  await adjustBalance(identityKey, -betDegen);

  // Provably-fair commit-reveal RNG — see the section above placeCoinTossBet
  // for the full scheme. Every flip is deterministic against the active
  // committed seed + an incrementing nonce, not a fresh random draw each
  // time, so results are reconstructable and verifiable once the seed
  // rotates and its raw value is revealed.
  const { result, serverSeedHash, nonce, clientSeed } = await resolveFlipOutcome(identityKey);
  const won = result === choice;

  let payoutDegen = 0;
  let feeTakenDegen = 0;
  if (won) {
    const profit = betDegen; // even-money coin toss: profit = stake on a win
    feeTakenDegen = profit * (config.feePercentOnWin / 100);
    payoutDegen = betDegen + (profit - feeTakenDegen);
    await adjustBalance(identityKey, payoutDegen);
  }

  const ts = Date.now();
  await recordFlip(identityKey, {
    id: `${identityKey}:${ts}`,
    identityKey,
    betDegen,
    choice,
    result,
    won,
    payoutDegen,
    feeTakenDegen,
    ts,
    serverSeedHash,
    nonce,
    clientSeed,
  });
  await recordPnl(ts, betDegen, payoutDegen);

  // Circuit breaker — check AFTER logging this flip so the triggering flip
  // itself is included in what admin reviews.
  const pnl = await getRolling24hPnl();
  if (-pnl.houseNet > config.lossCircuitBreakerDegen) {
    // houseNet negative ⇒ house is down; -houseNet is the house's net loss
    await setCoinTossConfig({ enabled: false });
    await pushAlert(
      `Auto-paused: rolling 24h house net loss (${(-pnl.houseNet).toFixed(2)} DEGEN) exceeded the ${config.lossCircuitBreakerDegen} DEGEN circuit-breaker threshold.`,
    );
  }

  // Provably-fair seed rotation — nonce here is the value the flip just
  // resolved against (pre-increment), so nonce+1 is how many flips this
  // seed has now backed. Rotating AFTER logging this flip (not before)
  // means the flip that crosses the threshold is still provably tied to
  // the seed whose hash it was resolved against, and the fresh seed only
  // starts backing the *next* flip.
  if (nonce + 1 >= config.seedRotateAfterFlips) {
    await rotateServerSeed();
  }

  const newBalance = await getBalance(identityKey);
  return { ok: true, result, won, payoutDegen, feeTakenDegen, newBalance, serverSeedHash, nonce, clientSeed };
}

// ── Cash-out ─────────────────────────────────────────────────────────────
export type PendingCashout = {
  id: string;
  identityKey: string;
  wallet: string;
  amountDegen: number;
  status: "pending" | "fulfilled" | "cancelled";
  txHash?: string;
  requestedAt: number;
  fulfilledAt?: number;
  cancelledAt?: number;
};

const CASHOUTS_KEY = "grub:minigames:cointoss:cashouts";

async function getAllCashouts(): Promise<PendingCashout[]> {
  return (await kv.get<PendingCashout[]>(CASHOUTS_KEY)) ?? [];
}

/**
 * Writes a "minigame_cashout" entry into the same txn-log KV lists that
 * app/api/txn-log/route.ts's POST handler writes — a self-contained copy
 * of that write path (per this file's convention for wallet-string
 * identities, same reasoning as that route's own header comment) rather
 * than an HTTP round-trip back to our own API. This was previously only
 * documented in txn-log/route.ts's comments but never actually implemented
 * here, which is why Coin Toss cash-outs stopped showing up in the
 * Transaction Log — this fixes that gap.
 */
async function logCashoutTxn(identityKey: string, amountDegen: number, txHash: string) {
  const entry = {
    fid: identityKey,
    type: "minigame_cashout" as const,
    txHash,
    amountUsd: 0, // internal-balance DEGEN cash-out, no USD leg tracked here
    amountDegen,
    ts: Date.now(),
  };

  try {
    const userKey = `txn-log:${identityKey}`;
    const userLog = (await kv.get<any[]>(userKey)) ?? [];
    userLog.push(entry);
    if (userLog.length > 200) userLog.splice(0, userLog.length - 200);
    await kv.set(userKey, userLog);

    const globalKey = "txn-log:all";
    const globalLog = (await kv.get<any[]>(globalKey)) ?? [];
    globalLog.push(entry);
    if (globalLog.length > 1000) globalLog.splice(0, globalLog.length - 1000);
    await kv.set(globalKey, globalLog);
  } catch (err) {
    // Never let a logging failure block or roll back a cash-out that
    // already sent real DEGEN on-chain — just surface it loudly.
    console.error("[minigames] logCashoutTxn failed:", err);
  }
}

export async function getPendingCashouts(): Promise<PendingCashout[]> {
  return (await getAllCashouts()).filter((c) => c.status === "pending");
}

/**
 * All cash-outs regardless of status (pending/fulfilled/cancelled), newest
 * first — unlike getPendingCashouts() above, a record never drops out of
 * this list just because it got actioned. The admin dashboard's "Cash-outs"
 * panel reads from this instead, so a cancelled request still shows up
 * (struck through, tagged "Cancelled") and a fulfilled one keeps its txn
 * link, rather than the record simply vanishing the moment it's handled.
 * getAllCashouts() already stores newest-first (requestCashout/fulfillCashout
 * unshift), so no re-sort is needed here.
 */
export async function getRecentCashouts(limit = 20): Promise<PendingCashout[]> {
  return (await getAllCashouts()).slice(0, limit);
}

/**
 * A single player's own cash-out history (pending + fulfilled), newest
 * first. This is what lets the Coin Toss UI show "your withdrawal is
 * queued" / "your withdrawal was sent" instead of the request just
 * disappearing into the admin-only queue with no visible trace for the
 * player who made it — same underlying CASHOUTS_KEY list the admin
 * dashboard reads, just filtered down to one identityKey.
 */
export async function getCashoutsForIdentity(identityKey: string, limit = 5): Promise<PendingCashout[]> {
  return (await getAllCashouts()).filter((c) => c.identityKey === identityKey).slice(0, limit);
}

export type CashoutRequestResult =
  | { ok: true; status: "fulfilled"; txHash: string }
  | { ok: true; status: "pending" }
  | { ok: false; reason: string };

/**
 * Requests a cash-out of internal balance to real on-chain DEGEN.
 * Auto-sends immediately if amountDegen ≤ config.autoCashoutMaxDegen (small,
 * low-risk amounts) using the exact same sendDegen() treasury flow as
 * raffle prizes/referral payouts. Anything larger queues for the admin
 * dashboard's manual "Send" button — same deliberate-trigger pattern used
 * everywhere else real money moves in this app.
 */
export async function requestCashout(identityKey: string, amountDegen: number, wallet: string): Promise<CashoutRequestResult> {
  if (!Number.isFinite(amountDegen) || amountDegen <= 0) {
    return { ok: false, reason: "invalid cash-out amount" };
  }
  // Guards this function itself, not just its one current caller
  // (app/api/minigames/cointoss/route.ts) — anything that calls
  // requestCashout() directly, now or later, gets the same protection.
  // This is what was missing when a manual cash-out went through with
  // wallet: "50": nothing anywhere validated the shape of `wallet` before
  // it reached sendDegen() below, so it landed in the admin queue instead
  // of failing fast with a clear reason. ethers.isAddress() (already
  // imported for the treasury balance read above) does a full EIP-55-aware
  // check, not just a regex shape match.
  if (!wallet || !ethers.isAddress(wallet.trim())) {
    return { ok: false, reason: "cashoutWallet must be a valid Base wallet address (0x followed by 40 hex characters)." };
  }
  const trimmedWallet = wallet.trim();
  const balance = await getBalance(identityKey);
  if (balance < amountDegen) {
    return { ok: false, reason: "Not enough balance to cash out that much." };
  }

  const lockKey = `grub:minigames:cashoutlock:${identityKey}`;
  const gotLock = await acquireLock(lockKey, 30);
  if (!gotLock) {
    return { ok: false, reason: "A cash-out is already in progress — try again shortly." };
  }

  try {
    // Deduct up front (mirrors bet deduction) — a failed send below just
    // means the record stays "pending" for the admin queue rather than
    // reversing this, so the balance never silently reappears while a
    // human sorts out what happened on-chain.
    await adjustBalance(identityKey, -amountDegen);

    const config = await getCoinTossConfig();
    const record: PendingCashout = {
      id: `${identityKey}:${Date.now()}`,
      identityKey,
      wallet: trimmedWallet,
      amountDegen,
      status: "pending",
      requestedAt: Date.now(),
    };

    if (amountDegen <= config.autoCashoutMaxDegen) {
      try {
        const txHash = await sendDegen(trimmedWallet, amountDegen);
        const fulfilled: PendingCashout = { ...record, status: "fulfilled", txHash, fulfilledAt: Date.now() };
        const list = await getAllCashouts();
        list.unshift(fulfilled);
        await kv.set(CASHOUTS_KEY, list);
        await logCashoutTxn(identityKey, amountDegen, txHash);
        return { ok: true, status: "fulfilled", txHash };
      } catch (err: any) {
        console.error("[minigames] auto-cashout sendDegen failed, falling back to pending queue:", err);
        // Falls through to the pending-queue path below — balance stays
        // deducted, record stays pending for admin to retry manually.
      }
    }

    const list = await getAllCashouts();
    list.unshift(record);
    await kv.set(CASHOUTS_KEY, list);
    return { ok: true, status: "pending" };
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * Cancels a still-pending cash-out (never sent on-chain — anything that
 * reached "fulfilled" already moved real DEGEN and can't be undone here).
 * Refunds the amount that requestCashout() deducted up front back into the
 * player's internal balance, mirroring cancelCredit()'s reversal pattern.
 */
export async function cancelCashout(cashoutId: string): Promise<
  { ok: true; identityKey: string; newBalance: number } | { ok: false; reason: string }
> {
  const list = await getAllCashouts();
  const idx = list.findIndex((c) => c.id === cashoutId);
  if (idx === -1) return { ok: false, reason: "cash-out not found" };

  const record = list[idx];
  if (record.status !== "pending") {
    return { ok: false, reason: `already ${record.status} — can't cancel` };
  }

  const newBalance = await adjustBalance(record.identityKey, record.amountDegen);
  list[idx] = { ...record, status: "cancelled", cancelledAt: Date.now() };
  await kv.set(CASHOUTS_KEY, list);

  console.log(`[minigames] cancelled cash-out ${cashoutId} — refunded ${record.amountDegen} DEGEN to ${record.identityKey}, new balance ${newBalance}`);
  return { ok: true, identityKey: record.identityKey, newBalance };
}

/** Admin-triggered fulfillment for anything that landed in the pending queue. */
export async function fulfillCashout(cashoutId: string): Promise<{ ok: true; txHash: string } | { ok: false; reason: string }> {
  const list = await getAllCashouts();
  const idx = list.findIndex((c) => c.id === cashoutId);
  if (idx === -1) return { ok: false, reason: "cash-out not found" };
  if (list[idx].status === "fulfilled") return { ok: false, reason: "already fulfilled" };

  const record = list[idx];
  try {
    const txHash = await sendDegen(record.wallet, record.amountDegen);
    list[idx] = { ...record, status: "fulfilled", txHash, fulfilledAt: Date.now() };
    await kv.set(CASHOUTS_KEY, list);
    await logCashoutTxn(record.identityKey, record.amountDegen, txHash);
    return { ok: true, txHash };
  } catch (err: any) {
    console.error("[minigames] fulfillCashout sendDegen failed:", err);
    return { ok: false, reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error" };
  }
}

// ── Per-player Coin Toss stats (Manage User + Games tab) ────────────────
// Reads from the permanent CoinTossTotals counter (bumped once per flip in
// recordFlip/bumpPlayerTotals above) rather than deriving from a stored
// flip list — so these numbers are true all-time, never affected by the
// FLIPS_KEY/per-identity-flips trim windows. Those trimmed lists are still
// used for "recent activity" feeds (getRecentFlips/getFlipsForIdentity),
// just not for the aggregate stats anymore.
export type CoinTossPlayerStats = {
  identityKey: string;
  balance: number;
  flips: number;
  wins: number;
  totalWagered: number; // sum of every bet placed, all-time
  betOnWins: number; // sum of betDegen on winning flips only (stake risked on wins, not the payout), all-time
  totalWon: number; // sum of payoutDegen on winning flips (gross return, stake + profit), all-time
  totalLost: number; // sum of betDegen on losing flips (stake forfeited), all-time
  totalDeposited: number; // sum of on-chain DEGEN deposits credited
  netProfitLoss: number; // totalWon − totalWagered — positive = up overall, negative = down
  lastPlayedAt: number;
};

function statsFromTotals(identityKey: string, totals: CoinTossTotals, totalDeposited: number, balance: number): CoinTossPlayerStats {
  return {
    identityKey,
    balance,
    flips: totals.flips,
    wins: totals.wins,
    totalWagered: totals.totalWagered,
    betOnWins: totals.betOnWins,
    totalWon: totals.totalWon,
    totalLost: totals.totalLost,
    totalDeposited,
    netProfitLoss: totals.totalWon - totals.totalWagered,
    lastPlayedAt: totals.lastPlayedAt,
  };
}

/**
 * One player's Coin Toss stats, or null if they've never flipped — used to
 * gate the Manage User panel's Coin Toss block so it only appears for users
 * who've actually played, same "played only" rule the Games tab table below
 * follows.
 */
export async function getCoinTossStatsForIdentity(identityKey: string): Promise<CoinTossPlayerStats | null> {
  const [totals, allDeposits, balance] = await Promise.all([
    kv.get<CoinTossTotals>(totalsKey(identityKey)),
    getAllDeposits(),
    getBalance(identityKey),
  ]);
  if (!totals || totals.flips === 0) return null;
  const totalDeposited = allDeposits.filter((d) => d.identityKey === identityKey).reduce((sum, d) => sum + d.amountDegen, 0);
  return statsFromTotals(identityKey, totals, totalDeposited, balance);
}

/**
 * Every identity that's placed at least one flip, with aggregated stats —
 * feeds the Games tab's "Player Stats" table. Sorted by most-recently-active
 * first so the players an admin is most likely checking on surface at top.
 * Player list comes from the append-only IDENTITIES_KEY index rather than
 * scanning a trimmed flip list, so a quiet player never silently drops off
 * the table just because other players have been more active recently.
 */
export async function getAllCoinTossPlayerStats(): Promise<CoinTossPlayerStats[]> {
  const [identities, allDeposits] = await Promise.all([kv.get<string[]>(IDENTITIES_KEY), getAllDeposits()]);
  const ids = identities ?? [];

  const depositsByIdentity = new Map<string, number>();
  for (const d of allDeposits) {
    depositsByIdentity.set(d.identityKey, (depositsByIdentity.get(d.identityKey) ?? 0) + d.amountDegen);
  }

  const [totalsList, balances] = await Promise.all([
    Promise.all(ids.map((id) => kv.get<CoinTossTotals>(totalsKey(id)))),
    Promise.all(ids.map((id) => getBalance(id))),
  ]);

  const stats: CoinTossPlayerStats[] = [];
  ids.forEach((identityKey, i) => {
    const totals = totalsList[i];
    if (!totals) return; // shouldn't happen — index and totals are written together in recordFlip
    stats.push(statsFromTotals(identityKey, totals, depositsByIdentity.get(identityKey) ?? 0, balances[i]));
  });

  stats.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  return stats;
}

/**
 * One-time migration: rebuilds the per-identity totals, per-identity flip
 * logs, the identity index, and the house-wide totals from whatever's
 * currently sitting in the shared FLIPS_KEY. Safe to run any time the site
 * is still under the MAX_LOGGED_FLIPS (500) global cap — at that point
 * FLIPS_KEY still holds every flip ever placed, so this is a complete,
 * lossless seed rather than a partial one. Once the site has ever exceeded
 * 500 total flips, anything trimmed off before running this is gone for
 * good — this can't recover data that's already been dropped from
 * FLIPS_KEY. Idempotent: re-running it just recomputes and overwrites, so
 * it's safe to trigger more than once (e.g. if run again before crossing
 * 500).
 */
export async function backfillCoinTossTotals(): Promise<{ identitiesSeeded: number; flipsProcessed: number }> {
  const allFlips = (await kv.get<CoinTossFlip[]>(FLIPS_KEY)) ?? [];

  const byIdentity = new Map<string, CoinTossFlip[]>();
  for (const f of allFlips) {
    const list = byIdentity.get(f.identityKey);
    if (list) list.push(f);
    else byIdentity.set(f.identityKey, [f]);
  }

  const identities = [...byIdentity.keys()];

  await Promise.all(
    identities.map(async (identityKey) => {
      const flips = byIdentity.get(identityKey)!; // FLIPS_KEY is newest-first
      const wonFlips = flips.filter((f) => f.won);
      const lostFlips = flips.filter((f) => !f.won);
      const totals: CoinTossTotals = {
        flips: flips.length,
        wins: wonFlips.length,
        totalWagered: flips.reduce((sum, f) => sum + f.betDegen, 0),
        betOnWins: wonFlips.reduce((sum, f) => sum + f.betDegen, 0),
        totalWon: wonFlips.reduce((sum, f) => sum + f.payoutDegen, 0),
        totalLost: lostFlips.reduce((sum, f) => sum + f.betDegen, 0),
        lastPlayedAt: flips[0]?.ts ?? 0,
      };
      await Promise.all([
        kv.set(totalsKey(identityKey), totals),
        kv.set(identityFlipsKey(identityKey), flips.slice(0, MAX_LOGGED_FLIPS_PER_PLAYER)),
      ]);
    }),
  );

  await kv.set(IDENTITIES_KEY, identities);

  // Seed house-level totals from the same complete flip list.
  const houseWins = allFlips.filter((f) => f.won).length;
  const houseTotals: CoinTossHouseTotals = {
    flips: allFlips.length,
    wins: houseWins,
    totalWagered: allFlips.reduce((sum, f) => sum + f.betDegen, 0),
    totalPaidOut: allFlips.reduce((sum, f) => sum + f.payoutDegen, 0),
  };
  await kv.set(HOUSE_TOTALS_KEY, houseTotals);

  return { identitiesSeeded: identities.length, flipsProcessed: allFlips.length };
}

export async function getCoinTossStats() {
  const [pnl, houseTotals] = await Promise.all([getRolling24hPnl(), kv.get<CoinTossHouseTotals>(HOUSE_TOTALS_KEY)]);
  const totals = houseTotals ?? { flips: 0, wins: 0, totalWagered: 0, totalPaidOut: 0 };
  return {
    allTime: {
      flips: totals.flips,
      totalWagered: totals.totalWagered,
      totalPaidOut: totals.totalPaidOut,
      houseNet: totals.totalWagered - totals.totalPaidOut,
      winRatePercent: totals.flips ? (totals.wins / totals.flips) * 100 : 0,
    },
    last24h: pnl,
    treasuryDegenBalance: await getTreasuryDegenBalance(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// APPEND EVERYTHING BELOW TO THE END OF lib/minigames.ts
// ════════════════════════════════════════════════════════════════════════
//
// DICE (Roll Under / Roll Over) — Mini Game #2.
//
// Shares Coin Toss's internal DEGEN balance + deposit + cash-out system
// entirely (getBalance / creditBalance / depositDegen / requestCashout —
// nothing new needed there, since it's all keyed by identityKey, not by
// game). This section only adds what's actually unique to Dice: its own
// config, its own provably-fair seed (separate rotation cadence from Coin
// Toss's), its own roll log/totals/P&L, and its own bet-resolution logic.
//
// Game mechanic: player picks a target (2–98) and a direction
// ("under" or "over"); the server draws a roll 1–100 against a committed
// seed. Win chance and payout multiplier are both derived from the target
// via a single formula — no per-number payout table needed, unlike a
// literal 6-sided die or roulette. See chat notes: the formula bakes in a
// constant house edge no matter which target/direction the player picks —
// riskier picks pay out more, but the AVERAGE house take stays the same.
// maxMultiplier/maxPayoutDegen exist purely to bound single-roll payout
// risk to the treasury, not to change that average edge.

// ── Config ───────────────────────────────────────────────────────────────
export type DiceConfig = {
  enabled: boolean;
  minBetDegen: number;
  maxBetDegen: number;
  maxBetPercentOfTreasury: number; // same idea as Coin Toss's — bet also capped at this % of live treasury
  houseEdgePercent: number; // e.g. 2 → house keeps ~2% of every bet on average, regardless of target picked
  minWinChancePercent: number; // floor on win chance a player can pick — caps the max multiplier from the low end (protects payout tail)
  maxWinChancePercent: number; // ceiling on win chance a player can pick — stops "almost guaranteed win, near-1x payout" bets from being pointless/spammy
  maxMultiplier: number; // hard cap on payout multiplier regardless of the formula — protects the pool from an extreme long-shot bet
  maxPayoutDegen: number; // hard cap on absolute payout for a single roll, regardless of bet size × multiplier
  lossCircuitBreakerDegen: number; // rolling 24h net house loss before auto-pause (own bucket, separate from Coin Toss's)
  maxRollsPerMinutePerUser: number;
  seedRotateAfterRolls: number; // provably-fair seed auto-rotates once it's backed this many rolls
};

const DEFAULT_DICE_CONFIG: DiceConfig = {
  enabled: true,
  minBetDegen: 10,
  maxBetDegen: 50,
  maxBetPercentOfTreasury: 3,
  houseEdgePercent: 2,
  minWinChancePercent: 2,
  maxWinChancePercent: 95,
  maxMultiplier: 25,
  maxPayoutDegen: 500,
  lossCircuitBreakerDegen: 500,
  maxRollsPerMinutePerUser: 10,
  seedRotateAfterRolls: 100,
};

const DICE_CONFIG_KEY = "grub:minigames:dice:config";

export async function getDiceConfig(): Promise<DiceConfig> {
  const stored = await kv.get<Partial<DiceConfig>>(DICE_CONFIG_KEY);
  // Merge over defaults so adding a new config field later doesn't require
  // a migration — same convention as getCoinTossConfig above.
  return { ...DEFAULT_DICE_CONFIG, ...(stored ?? {}) };
}

export async function setDiceConfig(patch: Partial<DiceConfig>): Promise<DiceConfig> {
  const current = await getDiceConfig();
  const updated = { ...current, ...patch };
  await kv.set(DICE_CONFIG_KEY, updated);
  return updated;
}

// ── Provably-fair seed — separate commitment from Coin Toss's, own
// rotation cadence (seedRotateAfterRolls, not seedRotateAfterFlips) ──────
type DiceActiveSeed = { serverSeed: string; serverSeedHash: string; nonce: number; createdAt: number };
type DiceRevealedSeed = { serverSeed: string; serverSeedHash: string; finalNonce: number; createdAt: number; revealedAt: number };

const DICE_ACTIVE_SEED_KEY = "grub:minigames:dice:activeseed";
const DICE_SEED_HISTORY_KEY = "grub:minigames:dice:seedhistory";
const MAX_LOGGED_DICE_SEEDS = 200;

export async function rotateDiceServerSeed(): Promise<DiceActiveSeed> {
  const existing = await kv.get<DiceActiveSeed>(DICE_ACTIVE_SEED_KEY);
  if (existing) {
    const history = (await kv.get<DiceRevealedSeed[]>(DICE_SEED_HISTORY_KEY)) ?? [];
    history.unshift({
      serverSeed: existing.serverSeed,
      serverSeedHash: existing.serverSeedHash,
      finalNonce: existing.nonce,
      createdAt: existing.createdAt,
      revealedAt: Date.now(),
    });
    if (history.length > MAX_LOGGED_DICE_SEEDS) history.length = MAX_LOGGED_DICE_SEEDS;
    await kv.set(DICE_SEED_HISTORY_KEY, history);
    console.log(`[minigames] rotated Dice server seed — outgoing seed used for ${existing.nonce} rolls, now revealed`);
  }

  const fresh: DiceActiveSeed = {
    serverSeed: randomBytes(32).toString("hex"),
    serverSeedHash: "",
    nonce: 0,
    createdAt: Date.now(),
  };
  fresh.serverSeedHash = sha256Hex(fresh.serverSeed); // sha256Hex already defined above, in the Coin Toss seed section
  await kv.set(DICE_ACTIVE_SEED_KEY, fresh);
  return fresh;
}

async function getOrCreateDiceActiveSeed(): Promise<DiceActiveSeed> {
  const existing = await kv.get<DiceActiveSeed>(DICE_ACTIVE_SEED_KEY);
  if (existing) return existing;
  return rotateDiceServerSeed(); // no active seed yet (first-ever roll) — mint one
}

export async function getDiceActiveSeedSummary(): Promise<{ serverSeedHash: string; rollsUsed: number; createdAt: number } | null> {
  const active = await kv.get<DiceActiveSeed>(DICE_ACTIVE_SEED_KEY);
  if (!active) return null;
  return { serverSeedHash: active.serverSeedHash, rollsUsed: active.nonce, createdAt: active.createdAt };
}

export async function getDiceSeedHistory(limit = 20): Promise<DiceRevealedSeed[]> {
  const history = (await kv.get<DiceRevealedSeed[]>(DICE_SEED_HISTORY_KEY)) ?? [];
  return history.slice(0, limit);
}

/**
 * Unbiased 0–99 draw from a 32-byte HMAC via rejection sampling across its
 * 4-byte chunks. Coin Toss's mod-2 reduction is automatically bias-free
 * since 2 is a power of two — 100 is NOT a power of two, so a naive
 * `uint32 % 100` would very slightly favor low remainders. Rejection
 * sampling (discard draws in the truncated tail above the largest clean
 * multiple of 100) removes that bias entirely.
 */
function hmacToRoll0to99(hmacHex: string): number {
  const CHUNK_HEX_LEN = 8; // 4 bytes = 8 hex chars
  const MAX_UINT32 = 0x100000000;
  const THRESHOLD = MAX_UINT32 - (MAX_UINT32 % 100); // largest multiple of 100 below 2^32
  for (let offset = 0; offset + CHUNK_HEX_LEN <= hmacHex.length; offset += CHUNK_HEX_LEN) {
    const chunk = parseInt(hmacHex.slice(offset, offset + CHUNK_HEX_LEN), 16);
    if (chunk < THRESHOLD) return chunk % 100;
  }
  // All 8 chunks landed in the rejected zone — astronomically unlikely
  // (roughly 1 in 4×10^17). Negligible bias in the one case this ever hits.
  return parseInt(hmacHex.slice(0, 8), 16) % 100;
}

async function resolveDiceOutcome(
  identityKey: string,
): Promise<{ roll: number; serverSeedHash: string; nonce: number; clientSeed: string }> {
  const active = await getOrCreateDiceActiveSeed();
  const nonce = active.nonce;
  // Reuses the same per-identity client seed Coin Toss uses (getOrCreateClientSeed,
  // defined above) — one persistent fairness seed per player, shared across
  // every game, rather than minting a second one just for Dice.
  const clientSeed = await getOrCreateClientSeed(identityKey);

  const hmac = createHmac("sha256", active.serverSeed).update(`dice:${clientSeed}:${nonce}`).digest("hex");
  const roll = hmacToRoll0to99(hmac) + 1; // 1–100

  await kv.set(DICE_ACTIVE_SEED_KEY, { ...active, nonce: nonce + 1 });
  return { roll, serverSeedHash: active.serverSeedHash, nonce, clientSeed };
}

// ── Roll log + rolling P&L ───────────────────────────────────────────────
export type DiceRoll = {
  id: string;
  identityKey: string;
  betDegen: number;
  target: number; // 2–98
  direction: "under" | "over";
  roll: number; // 1–100
  won: boolean;
  winChancePercent: number;
  multiplier: number;
  payoutDegen: number; // 0 if lost
  ts: number;
  serverSeedHash: string;
  nonce: number;
  clientSeed: string;
};

const DICE_ROLLS_KEY = "grub:minigames:dice:rolls";
const MAX_LOGGED_DICE_ROLLS = 500; // global, all-players window — mirrors FLIPS_KEY

async function logDiceRoll(roll: DiceRoll) {
  const list = (await kv.get<DiceRoll[]>(DICE_ROLLS_KEY)) ?? [];
  list.unshift(roll);
  if (list.length > MAX_LOGGED_DICE_ROLLS) list.length = MAX_LOGGED_DICE_ROLLS;
  await kv.set(DICE_ROLLS_KEY, list);
}

export async function getRecentDiceRolls(limit = 20): Promise<DiceRoll[]> {
  const list = (await kv.get<DiceRoll[]>(DICE_ROLLS_KEY)) ?? [];
  return list.slice(0, limit);
}

// ── Per-player roll history — own key per identity, mirrors Coin Toss's
// identityFlipsKey pattern so a quiet player's rolls never get pushed out
// by other players' activity. ──────────────────────────────────────────
const MAX_LOGGED_DICE_ROLLS_PER_PLAYER = 500;

function identityDiceRollsKey(identityKey: string) {
  return `grub:minigames:dice:rolls:${identityKey}`;
}

async function logDiceRollForIdentity(identityKey: string, roll: DiceRoll) {
  const key = identityDiceRollsKey(identityKey);
  const list = (await kv.get<DiceRoll[]>(key)) ?? [];
  list.unshift(roll);
  if (list.length > MAX_LOGGED_DICE_ROLLS_PER_PLAYER) list.length = MAX_LOGGED_DICE_ROLLS_PER_PLAYER;
  await kv.set(key, list);
}

export async function getDiceRollsForIdentity(identityKey: string, limit = 20): Promise<DiceRoll[]> {
  const list = (await kv.get<DiceRoll[]>(identityDiceRollsKey(identityKey))) ?? [];
  return list.slice(0, limit);
}

// ── Per-player running totals (all-time, never trimmed) ─────────────────
export type DiceTotals = {
  rolls: number;
  wins: number;
  totalWagered: number;
  betOnWins: number;
  totalWon: number;
  totalLost: number;
  lastPlayedAt: number;
};

function diceTotalsKey(identityKey: string) {
  return `grub:minigames:dice:totals:${identityKey}`;
}

async function bumpDicePlayerTotals(identityKey: string, roll: DiceRoll): Promise<DiceTotals> {
  const key = diceTotalsKey(identityKey);
  const current = (await kv.get<DiceTotals>(key)) ?? {
    rolls: 0,
    wins: 0,
    totalWagered: 0,
    betOnWins: 0,
    totalWon: 0,
    totalLost: 0,
    lastPlayedAt: 0,
  };
  current.rolls += 1;
  current.totalWagered += roll.betDegen;
  current.lastPlayedAt = roll.ts;
  if (roll.won) {
    current.wins += 1;
    current.betOnWins += roll.betDegen;
    current.totalWon += roll.payoutDegen;
  } else {
    current.totalLost += roll.betDegen;
  }
  await kv.set(key, current);
  return current;
}

// ── Index of every identity that's ever placed a Dice bet ───────────────
const DICE_IDENTITIES_KEY = "grub:minigames:dice:identities";

async function trackDiceIdentity(identityKey: string) {
  const list = (await kv.get<string[]>(DICE_IDENTITIES_KEY)) ?? [];
  if (!list.includes(identityKey)) {
    list.push(identityKey);
    await kv.set(DICE_IDENTITIES_KEY, list);
  }
}

// ── House-level running totals (all-time, never trimmed) ────────────────
export type DiceHouseTotals = {
  rolls: number;
  wins: number;
  totalWagered: number;
  totalPaidOut: number;
};

const DICE_HOUSE_TOTALS_KEY = "grub:minigames:dice:house_totals";

async function bumpDiceHouseTotals(roll: DiceRoll): Promise<DiceHouseTotals> {
  const current = (await kv.get<DiceHouseTotals>(DICE_HOUSE_TOTALS_KEY)) ?? {
    rolls: 0,
    wins: 0,
    totalWagered: 0,
    totalPaidOut: 0,
  };
  current.rolls += 1;
  current.totalWagered += roll.betDegen;
  current.totalPaidOut += roll.payoutDegen;
  if (roll.won) current.wins += 1;
  await kv.set(DICE_HOUSE_TOTALS_KEY, current);
  return current;
}

async function recordDiceRoll(identityKey: string, roll: DiceRoll) {
  await Promise.all([
    logDiceRoll(roll),
    logDiceRollForIdentity(identityKey, roll),
    bumpDicePlayerTotals(identityKey, roll),
    bumpDiceHouseTotals(roll),
    trackDiceIdentity(identityKey),
  ]);
}

/**
 * Clears just the WIN/LOSS ROLL HISTORY for one identity — mirrors
 * purgeCoinTossFlipHistory exactly. Does NOT touch balance, deposits,
 * cash-outs, manual credit history, or client seed.
 */
export async function purgeDiceRollHistory(identityKey: string): Promise<{ rollsRemoved: number }> {
  const [globalRolls, myRolls, houseTotals] = await Promise.all([
    kv.get<DiceRoll[]>(DICE_ROLLS_KEY),
    kv.get<DiceRoll[]>(identityDiceRollsKey(identityKey)),
    kv.get<DiceHouseTotals>(DICE_HOUSE_TOTALS_KEY),
  ]);

  const removed = new Map<string, DiceRoll>();
  for (const r of globalRolls ?? []) if (r.identityKey === identityKey) removed.set(r.id, r);
  for (const r of myRolls ?? []) if (r.identityKey === identityKey) removed.set(r.id, r);
  const removedRolls = [...removed.values()];

  const remainingGlobal = (globalRolls ?? []).filter((r) => r.identityKey !== identityKey);

  const ops: Promise<any>[] = [
    kv.set(DICE_ROLLS_KEY, remainingGlobal),
    kv.del(identityDiceRollsKey(identityKey)),
    kv.del(diceTotalsKey(identityKey)),
  ];

  const list = (await kv.get<string[]>(DICE_IDENTITIES_KEY)) ?? [];
  if (list.includes(identityKey)) {
    ops.push(kv.set(DICE_IDENTITIES_KEY, list.filter((id) => id !== identityKey)));
  }

  if (houseTotals && removedRolls.length > 0) {
    const wins = removedRolls.filter((r) => r.won).length;
    const totalWagered = removedRolls.reduce((sum, r) => sum + r.betDegen, 0);
    const totalPaidOut = removedRolls.reduce((sum, r) => sum + r.payoutDegen, 0);
    const adjusted: DiceHouseTotals = {
      rolls: Math.max(0, houseTotals.rolls - removedRolls.length),
      wins: Math.max(0, houseTotals.wins - wins),
      totalWagered: Math.max(0, houseTotals.totalWagered - totalWagered),
      totalPaidOut: Math.max(0, houseTotals.totalPaidOut - totalPaidOut),
    };
    ops.push(kv.set(DICE_HOUSE_TOTALS_KEY, adjusted));
  }

  await Promise.all(ops);
  return { rollsRemoved: removedRolls.length };
}

// ── Dice's own rolling 24h P&L buckets — separate from Coin Toss's, so
// each game's circuit breaker reacts only to its own recent activity. ───
function diceHourBucketKey(ts: number) {
  const hour = Math.floor(ts / (60 * 60 * 1000));
  return `grub:minigames:dice:pnl:${hour}`;
}

async function recordDicePnl(ts: number, wagered: number, paidOut: number) {
  const key = diceHourBucketKey(ts);
  const existing = (await kv.get<{ wagered: number; paidOut: number }>(key)) ?? { wagered: 0, paidOut: 0 };
  const updated = { wagered: existing.wagered + wagered, paidOut: existing.paidOut + paidOut };
  await kv.set(key, updated, { ex: 60 * 60 * 48 });
  return updated;
}

export async function getDiceRolling24hPnl(): Promise<{ wagered: number; paidOut: number; houseNet: number }> {
  const now = Date.now();
  let wagered = 0;
  let paidOut = 0;
  for (let i = 0; i < 24; i++) {
    const bucket = await kv.get<{ wagered: number; paidOut: number }>(diceHourBucketKey(now - i * 60 * 60 * 1000));
    if (bucket) {
      wagered += bucket.wagered;
      paidOut += bucket.paidOut;
    }
  }
  return { wagered, paidOut, houseNet: wagered - paidOut };
}

const DICE_ALERTS_KEY = "grub:minigames:dice:alerts";
export type DiceAlert = { id: string; message: string; ts: number };

async function pushDiceAlert(message: string) {
  const list = (await kv.get<DiceAlert[]>(DICE_ALERTS_KEY)) ?? [];
  list.unshift({ id: `${Date.now()}`, message, ts: Date.now() });
  if (list.length > 50) list.length = 50;
  await kv.set(DICE_ALERTS_KEY, list);
  console.error(`[minigames] DICE ALERT: ${message}`);
}

export async function getDiceAlerts(): Promise<DiceAlert[]> {
  return (await kv.get<DiceAlert[]>(DICE_ALERTS_KEY)) ?? [];
}

// ── Rate limiting — own bucket, same shape as Coin Toss's ────────────────
async function checkDiceRateLimit(identityKey: string, maxPerMinute: number): Promise<boolean> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `grub:minigames:dice:ratelimit:${identityKey}:${minuteBucket}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, 70);
  return count <= maxPerMinute;
}

// ── Placing a Dice bet ───────────────────────────────────────────────────
export type PlaceDiceBetResult =
  | {
      ok: true;
      roll: number;
      target: number;
      direction: "under" | "over";
      won: boolean;
      winChancePercent: number;
      multiplier: number;
      payoutDegen: number;
      newBalance: number;
      serverSeedHash: string;
      nonce: number;
      clientSeed: string;
    }
  | { ok: false; reason: string };

export async function placeDiceBet(
  identityKey: string,
  betDegen: number,
  target: number,
  direction: "under" | "over",
): Promise<PlaceDiceBetResult> {
  const config = await getDiceConfig();

  if (!config.enabled) {
    return { ok: false, reason: "Dice is paused right now — check back soon." };
  }
  if (direction !== "under" && direction !== "over") {
    return { ok: false, reason: "direction must be under or over" };
  }
  if (!Number.isFinite(betDegen) || betDegen <= 0) {
    return { ok: false, reason: "invalid bet amount" };
  }
  if (betDegen < config.minBetDegen || betDegen > config.maxBetDegen) {
    return { ok: false, reason: `Bet must be between ${config.minBetDegen} and ${config.maxBetDegen} DEGEN.` };
  }
  if (!Number.isInteger(target) || target < 2 || target > 98) {
    return { ok: false, reason: "target must be a whole number between 2 and 98" };
  }

  // Win chance is derived straight from target + direction (roll is
  // 1–100): "under N" wins on any roll from 1..N-1 → (N-1)% chance;
  // "over N" wins on any roll from N+1..100 → (100-N)% chance. Clamped by
  // config so no one can pick a target outside the admin-configured range
  // (this is what minWinChancePercent/maxWinChancePercent actually gate).
  const winChancePercent = direction === "under" ? target - 1 : 100 - target;
  if (winChancePercent < config.minWinChancePercent || winChancePercent > config.maxWinChancePercent) {
    return {
      ok: false,
      reason: `Win chance must be between ${config.minWinChancePercent}% and ${config.maxWinChancePercent}% — pick a less extreme target.`,
    };
  }

  // Same treasury-based cap Coin Toss uses.
  const treasuryBalance = await getTreasuryDegenBalance();
  const treasuryCap = treasuryBalance * (config.maxBetPercentOfTreasury / 100);
  if (treasuryBalance > 0 && betDegen > treasuryCap) {
    return { ok: false, reason: "Bet exceeds the current treasury-based max — try a smaller amount." };
  }

  const underRateLimit = await checkDiceRateLimit(identityKey, config.maxRollsPerMinutePerUser);
  if (!underRateLimit) {
    return { ok: false, reason: "Slow down — too many rolls this minute, try again shortly." };
  }

  const balance = await getBalance(identityKey);
  if (balance < betDegen) {
    return { ok: false, reason: "Not enough DEGEN balance for that bet." };
  }

  // Multiplier formula — see chat notes: this bakes in a CONSTANT average
  // house edge across every target/direction. maxMultiplier only clips the
  // extreme tail (very low win-chance bets); it doesn't change the edge on
  // bets that don't hit the cap.
  const rawMultiplier = (100 / winChancePercent) * (1 - config.houseEdgePercent / 100);
  const multiplier = Math.min(rawMultiplier, config.maxMultiplier);

  // Deduct the stake up front, then resolve — same ordering as placeCoinTossBet.
  await adjustBalance(identityKey, -betDegen);

  const { roll, serverSeedHash, nonce, clientSeed } = await resolveDiceOutcome(identityKey);
  const won = direction === "under" ? roll < target : roll > target;

  let payoutDegen = 0;
  if (won) {
    // maxPayoutDegen is the last line of defense — bounds a single roll's
    // payout regardless of how the multiplier and bet size combine.
    payoutDegen = Math.min(betDegen * multiplier, config.maxPayoutDegen);
    await adjustBalance(identityKey, payoutDegen);
  }

  const ts = Date.now();
  await recordDiceRoll(identityKey, {
    id: `${identityKey}:${ts}`,
    identityKey,
    betDegen,
    target,
    direction,
    roll,
    won,
    winChancePercent,
    multiplier,
    payoutDegen,
    ts,
    serverSeedHash,
    nonce,
    clientSeed,
  });
  await recordDicePnl(ts, betDegen, payoutDegen);

  // Circuit breaker — own bucket/threshold from Coin Toss's, checked after
  // logging so the triggering roll is included in what admin reviews.
  const pnl = await getDiceRolling24hPnl();
  if (-pnl.houseNet > config.lossCircuitBreakerDegen) {
    await setDiceConfig({ enabled: false });
    await pushDiceAlert(
      `Auto-paused: rolling 24h house net loss (${(-pnl.houseNet).toFixed(2)} DEGEN) exceeded the ${config.lossCircuitBreakerDegen} DEGEN circuit-breaker threshold.`,
    );
  }

  // Seed rotation — same "after logging, before the next roll" ordering as Coin Toss.
  if (nonce + 1 >= config.seedRotateAfterRolls) {
    await rotateDiceServerSeed();
  }

  const newBalance = await getBalance(identityKey);
  return {
    ok: true,
    roll,
    target,
    direction,
    won,
    winChancePercent,
    multiplier,
    payoutDegen,
    newBalance,
    serverSeedHash,
    nonce,
    clientSeed,
  };
}

// ── Per-player Dice stats + house-wide stats (mirrors Coin Toss section) ─
export type DicePlayerStats = {
  identityKey: string;
  balance: number;
  rolls: number;
  wins: number;
  totalWagered: number;
  betOnWins: number;
  totalWon: number;
  totalLost: number;
  netProfitLoss: number;
  lastPlayedAt: number;
};

function diceStatsFromTotals(identityKey: string, totals: DiceTotals, balance: number): DicePlayerStats {
  return {
    identityKey,
    balance,
    rolls: totals.rolls,
    wins: totals.wins,
    totalWagered: totals.totalWagered,
    betOnWins: totals.betOnWins,
    totalWon: totals.totalWon,
    totalLost: totals.totalLost,
    netProfitLoss: totals.totalWon - totals.totalWagered,
    lastPlayedAt: totals.lastPlayedAt,
  };
}

export async function getDiceStatsForIdentity(identityKey: string): Promise<DicePlayerStats | null> {
  const [totals, balance] = await Promise.all([kv.get<DiceTotals>(diceTotalsKey(identityKey)), getBalance(identityKey)]);
  if (!totals || totals.rolls === 0) return null;
  return diceStatsFromTotals(identityKey, totals, balance);
}

/**
 * Every identity that's placed at least one Dice bet, with aggregated
 * stats — feeds the Games tab's Dice "Player Stats" table. Same
 * "read from the append-only identity index" approach as
 * getAllCoinTossPlayerStats, for the same reason (a quiet player never
 * silently drops off the table).
 */
export async function getAllDicePlayerStats(): Promise<DicePlayerStats[]> {
  const identities = (await kv.get<string[]>(DICE_IDENTITIES_KEY)) ?? [];

  const [totalsList, balances] = await Promise.all([
    Promise.all(identities.map((id) => kv.get<DiceTotals>(diceTotalsKey(id)))),
    Promise.all(identities.map((id) => getBalance(id))),
  ]);

  const stats: DicePlayerStats[] = [];
  identities.forEach((identityKey, i) => {
    const totals = totalsList[i];
    if (!totals) return;
    stats.push(diceStatsFromTotals(identityKey, totals, balances[i]));
  });

  stats.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  return stats;
}

export async function getDiceStats() {
  const [pnl, houseTotals] = await Promise.all([getDiceRolling24hPnl(), kv.get<DiceHouseTotals>(DICE_HOUSE_TOTALS_KEY)]);
  const totals = houseTotals ?? { rolls: 0, wins: 0, totalWagered: 0, totalPaidOut: 0 };
  return {
    allTime: {
      rolls: totals.rolls,
      totalWagered: totals.totalWagered,
      totalPaidOut: totals.totalPaidOut,
      houseNet: totals.totalWagered - totals.totalPaidOut,
      winRatePercent: totals.rolls ? (totals.wins / totals.rolls) * 100 : 0,
    },
    last24h: pnl,
    treasuryDegenBalance: await getTreasuryDegenBalance(),
  };
}
