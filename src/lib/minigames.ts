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

/**
 * A single player's own flip history (most recent first) — the actual fix
 * for the "recent flips" strip showing identical results for every user.
 * getRecentFlips() above pulls from the shared, all-players FLIPS_KEY list
 * with no identity filter at all, so every caller was getting the exact
 * same global feed. This filters that same list down to one identityKey,
 * same "safe to return in full, it's the caller's own data" reasoning as
 * getCashoutsForIdentity/getDepositsForIdentity.
 */
export async function getFlipsForIdentity(identityKey: string, limit = 20): Promise<CoinTossFlip[]> {
  const list = (await kv.get<CoinTossFlip[]>(FLIPS_KEY)) ?? [];
  return list.filter((f) => f.identityKey === identityKey).slice(0, limit);
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
// Aggregates a player's own flips + deposits into the same shape the admin
// dashboard already shows at the house level via getCoinTossStats() below —
// totalWagered/totalWon here mirror that function's totalWagered/
// totalPaidOut, just filtered to one identityKey instead of summed across
// everyone. Same FLIPS_KEY-is-a-trimmed-window caveat applies: a player who
// flipped a lot before the most recent MAX_LOGGED_FLIPS trim will show a
// partial history here, same as the site-wide "all-time" stats already do.
export type CoinTossPlayerStats = {
  identityKey: string;
  balance: number;
  flips: number;
  wins: number;
  totalWagered: number; // sum of every bet placed
  betOnWins: number; // sum of betDegen on winning flips only (stake risked on wins, not the payout)
  totalWon: number; // sum of payoutDegen on winning flips (gross return, stake + profit)
  totalLost: number; // sum of betDegen on losing flips (stake forfeited)
  totalDeposited: number; // sum of on-chain DEGEN deposits credited
  netProfitLoss: number; // totalWon − totalWagered — positive = up overall, negative = down
  lastPlayedAt: number;
};

function buildPlayerStats(identityKey: string, flips: CoinTossFlip[], totalDeposited: number, balance: number): CoinTossPlayerStats {
  const wonFlips = flips.filter((f) => f.won);
  const lostFlips = flips.filter((f) => !f.won);
  const totalWagered = flips.reduce((sum, f) => sum + f.betDegen, 0);
  const betOnWins = wonFlips.reduce((sum, f) => sum + f.betDegen, 0);
  const totalWon = wonFlips.reduce((sum, f) => sum + f.payoutDegen, 0);
  const totalLost = lostFlips.reduce((sum, f) => sum + f.betDegen, 0);
  return {
    identityKey,
    balance,
    flips: flips.length,
    wins: wonFlips.length,
    totalWagered,
    betOnWins,
    totalWon,
    totalLost,
    totalDeposited,
    netProfitLoss: totalWon - totalWagered,
    lastPlayedAt: flips[0]?.ts ?? 0, // FLIPS_KEY is stored newest-first
  };
}

/**
 * One player's Coin Toss stats, or null if they've never flipped — used to
 * gate the Manage User panel's Coin Toss block so it only appears for users
 * who've actually played, same "played only" rule the Games tab table below
 * follows.
 */
export async function getCoinTossStatsForIdentity(identityKey: string): Promise<CoinTossPlayerStats | null> {
  const [allFlips, allDeposits, balance] = await Promise.all([
    kv.get<CoinTossFlip[]>(FLIPS_KEY),
    getAllDeposits(),
    getBalance(identityKey),
  ]);
  const mine = (allFlips ?? []).filter((f) => f.identityKey === identityKey);
  if (mine.length === 0) return null;
  const totalDeposited = allDeposits.filter((d) => d.identityKey === identityKey).reduce((sum, d) => sum + d.amountDegen, 0);
  return buildPlayerStats(identityKey, mine, totalDeposited, balance);
}

/**
 * Every identity that's placed at least one flip, with aggregated stats —
 * feeds the Games tab's "Player Stats" table. Sorted by most-recently-active
 * first so the players an admin is most likely checking on surface at top.
 */
export async function getAllCoinTossPlayerStats(): Promise<CoinTossPlayerStats[]> {
  const [allFlips, allDeposits] = await Promise.all([kv.get<CoinTossFlip[]>(FLIPS_KEY), getAllDeposits()]);

  const flipsByIdentity = new Map<string, CoinTossFlip[]>();
  for (const f of allFlips ?? []) {
    const list = flipsByIdentity.get(f.identityKey);
    if (list) list.push(f);
    else flipsByIdentity.set(f.identityKey, [f]);
  }

  const depositsByIdentity = new Map<string, number>();
  for (const d of allDeposits) {
    depositsByIdentity.set(d.identityKey, (depositsByIdentity.get(d.identityKey) ?? 0) + d.amountDegen);
  }

  const identities = [...flipsByIdentity.keys()];
  const balances = await Promise.all(identities.map((id) => getBalance(id)));

  const stats = identities.map((identityKey, i) =>
    buildPlayerStats(identityKey, flipsByIdentity.get(identityKey)!, depositsByIdentity.get(identityKey) ?? 0, balances[i]),
  );

  stats.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  return stats;
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
