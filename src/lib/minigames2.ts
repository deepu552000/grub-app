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

import { randomBytes } from "crypto";
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

/**
 * Admin-only top-up — the only way DEGEN gets INTO a player's internal
 * balance today is this, or a raffle DEGEN prize being routed here instead
 * of straight on-chain (your call later). Kept separate from adjustBalance
 * so every credit that isn't a game outcome is deliberate and logged.
 *
 * This is an internal-balance adjustment only — nothing moves on-chain, so
 * it deliberately does NOT go into the main txn-log (that log is reserved
 * for real blockchain transactions — see logCashoutTxn below). It's logged
 * to its own history instead, surfaced only in the mini-games admin block.
 */
export async function creditBalance(identityKey: string, amountDegen: number, reason: string): Promise<number> {
  const next = await adjustBalance(identityKey, amountDegen);
  await logCredit({
    id: `${identityKey}:${Date.now()}`,
    identityKey,
    amountDegen,
    reason,
    newBalance: next,
    ts: Date.now(),
  });
  console.log(`[minigames] credited ${amountDegen} DEGEN to ${identityKey} (${reason}) — new balance ${next}`);
  return next;
}

// ── Manual credit history ────────────────────────────────────────────────
// Separate from the flip/cashout logs above and from the app-wide txn-log —
// a manual top-up isn't a game outcome and isn't a blockchain transaction,
// so it belongs only here, surfaced in the mini-games admin block's "Add
// DEGEN Balance" panel rather than the dashboard's main Transaction Log.
export type CoinTossCredit = {
  id: string;
  identityKey: string;
  amountDegen: number;
  reason: string;
  newBalance: number;
  ts: number;
};

const CREDITS_KEY = "grub:minigames:cointoss:credits";
const MAX_LOGGED_CREDITS = 200;

async function logCredit(entry: CoinTossCredit) {
  const list = (await kv.get<CoinTossCredit[]>(CREDITS_KEY)) ?? [];
  list.unshift(entry);
  if (list.length > MAX_LOGGED_CREDITS) list.length = MAX_LOGGED_CREDITS;
  await kv.set(CREDITS_KEY, list);
}

export async function getCreditHistory(limit = 50): Promise<CoinTossCredit[]> {
  const list = (await kv.get<CoinTossCredit[]>(CREDITS_KEY)) ?? [];
  return list.slice(0, limit);
}

// ── Txn-log entries for completed cash-outs ─────────────────────────────
// A cash-out that actually sends real DEGEN on-chain (auto-send or admin
// "Send") is a genuine blockchain transaction, same category as referral
// payouts and raffle prizes — so unlike the manual-credit log above, this
// one DOES belong in the app-wide txn-log the main dashboard reads (see
// app/api/txn-log/route.ts), so it shows up in both "All Transactions" /
// "Transactions by Type" AND the mini-games block's own history.
//
// Self-contained copy of that route's write path rather than an HTTP
// round-trip or a shared import — same reasoning as getTreasuryDegenBalance
// above (small, stable pattern; not worth coupling this file's deploy to
// that route's).
async function logCashoutTxn(identityKey: string, amountDegen: number, txHash: string) {
  const entry = {
    fid: identityKey,
    type: "minigame_cashout" as const,
    txHash,
    amountUsd: 0,
    amountDegen,
    ts: Date.now(),
  };

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
};

const FLIPS_KEY = "grub:minigames:cointoss:flips";
const MAX_LOGGED_FLIPS = 500; // trim so this key doesn't grow unbounded

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

  // Server RNG — single secure random byte, even/odd split. Not
  // provably-fair (see file header) but every flip is logged for aggregate
  // auditing (win rate should track ~50% over time).
  const result: "heads" | "tails" = randomBytes(1)[0] % 2 === 0 ? "heads" : "tails";
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
  await logFlip({
    id: `${identityKey}:${ts}`,
    identityKey,
    betDegen,
    choice,
    result,
    won,
    payoutDegen,
    feeTakenDegen,
    ts,
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

  const newBalance = await getBalance(identityKey);
  return { ok: true, result, won, payoutDegen, feeTakenDegen, newBalance };
}

// ── Cash-out ─────────────────────────────────────────────────────────────
export type PendingCashout = {
  id: string;
  identityKey: string;
  wallet: string;
  amountDegen: number;
  status: "pending" | "fulfilled";
  txHash?: string;
  requestedAt: number;
  fulfilledAt?: number;
};

const CASHOUTS_KEY = "grub:minigames:cointoss:cashouts";

async function getAllCashouts(): Promise<PendingCashout[]> {
  return (await kv.get<PendingCashout[]>(CASHOUTS_KEY)) ?? [];
}

export async function getPendingCashouts(): Promise<PendingCashout[]> {
  return (await getAllCashouts()).filter((c) => c.status === "pending");
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
      wallet,
      amountDegen,
      status: "pending",
      requestedAt: Date.now(),
    };

    if (amountDegen <= config.autoCashoutMaxDegen) {
      try {
        const txHash = await sendDegen(wallet, amountDegen);
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

export async function getCoinTossStats() {
  const pnl = await getRolling24hPnl();
  const allFlips = (await kv.get<CoinTossFlip[]>(FLIPS_KEY)) ?? [];
  const totalWagered = allFlips.reduce((sum, f) => sum + f.betDegen, 0);
  const totalPaidOut = allFlips.reduce((sum, f) => sum + f.payoutDegen, 0);
  const wins = allFlips.filter((f) => f.won).length;
  return {
    allTime: {
      flips: allFlips.length,
      totalWagered,
      totalPaidOut,
      houseNet: totalWagered - totalPaidOut,
      winRatePercent: allFlips.length ? (wins / allFlips.length) * 100 : 0,
    },
    last24h: pnl,
    treasuryDegenBalance: await getTreasuryDegenBalance(),
  };
}
