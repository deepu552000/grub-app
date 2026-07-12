// lib/referral.ts
//
// Shared helpers for referral payouts and wallet lookup.
// Used by /api/referral/register and /api/referral/checkin

import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { Attribution } from "ox/erc8021";
import { petKey } from "@/lib/pet-key";
import { getNames } from "@coinbase/onchainkit/identity";
import { base } from "viem/chains";

const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DEGEN_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];
const DEGEN_IFACE = new ethers.Interface(DEGEN_ABI);

// Same Base Builder Code used on the client (see Client.tsx) — appended as a
// data suffix so DEGEN referral payouts attribute to this app too, same as
// checkin/accessory USDC payments. From base.dev > Settings > Builder Codes.
const BUILDER_CODE_SUFFIX = Attribution.toDataSuffix({
  codes: ["bc_sj35j3xa"],
});

const FAILED_PAYOUTS_KEY = "failed-payouts";

// A DEGEN payout that failed to send (e.g. treasury wallet ran out of DEGEN,
// RPC hiccup, bad wallet address, etc). Logged so it can be retried from the
// dashboard once the underlying issue (usually: refill the treasury) is fixed.
export type FailedPayout = {
  id: string;
  fid: number | string;        // fid, or "wallet:0x..." for Base — see logDegenTxn
  toFid: number | string;      // fid, or "wallet:0x..." for Base
  toWallet: string;
  amountDegen: number;
  type: "referral_join" | "referral_checkin";
  reason: string;
  ts: number;
  // Optional KV write to apply once the retry succeeds (e.g. marking a
  // referral checkin as "paid" — skipped on the original failed attempt).
  sideEffect?: { kvKey: string; kvValue: any } | null;
  // Set ONLY when the transfer was actually broadcast on-chain but confirming
  // it (tx.wait()) then threw — e.g. ethers' "could not coalesce error", an
  // RPC hiccup during confirmation polling. In this case the DEGEN may
  // already have been sent despite the error. NEVER auto-retry when this is
  // present — always verify the hash on Basescan first (dismiss if it landed,
  // retry only if it genuinely didn't).
  broadcastTxHash?: string | null;
};

export async function recordFailedPayout(
  entry: Omit<FailedPayout, "id" | "ts">
): Promise<FailedPayout> {
  const record: FailedPayout = {
    ...entry,
    id: `${entry.type}:${entry.toFid}:${Date.now()}`,
    ts: Date.now(),
  };
  const list = (await kv.get<FailedPayout[]>(FAILED_PAYOUTS_KEY)) ?? [];
  list.push(record);
  await kv.set(FAILED_PAYOUTS_KEY, list);
  console.error(`[referral] payout FAILED — logged for retry: ${record.id} (${record.reason})`);
  return record;
}

// ── Distributed lock ──────────────────────────────────────────────────────
// Prevents two concurrent attempts to pay the SAME bonus from both succeeding
// (e.g. a manual dashboard retry racing the user's next natural checkin).
// Uses Vercel KV's NX+EX (only-set-if-absent, auto-expire) — same primitive
// as a Redis lock. TTL is a safety net in case releaseLock never runs
// (crashed request, etc.) so a stuck lock can't block forever.
export async function acquireLock(key: string, ttlSeconds = 30): Promise<boolean> {
  const result = await kv.set(key, "1", { nx: true, ex: ttlSeconds } as any);
  return result !== null;
}

export async function releaseLock(key: string): Promise<void> {
  try {
    await kv.del(key);
  } catch {
    /* lock will still expire via TTL */
  }
}

// Send DEGEN from treasury wallet to a recipient address.
// amount = whole DEGEN units (e.g. 1 or 2)
//
// IMPORTANT: this can throw even after the transfer was already broadcast
// and mined — ethers v6 can throw errors like "could not coalesce error"
// purely from an RPC hiccup during confirmation polling, with the actual
// on-chain transfer having already succeeded. To avoid silently losing track
// of money that already moved, we capture tx.hash the moment contract.transfer()
// returns (before calling .wait()) and attach it to any error thrown after
// that point, via err.broadcastTxHash. Callers MUST check for this field —
// its presence means "verify on Basescan before deciding to retry."
export async function sendDegen(
  toAddress: string,
  amount: number
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
  );
  const treasury = new ethers.Wallet(
    process.env.TREASURY_PRIVATE_KEY!,
    provider
  );
  // Build the transfer(address,uint256) calldata by hand (instead of
  // contract.transfer(), which encodes-and-sends internally and gives us no
  // way to touch `data`) so we can append the Builder Code attribution
  // suffix — same trick as sendUsdcPayment on the client. The contract only
  // reads the first 68 bytes for transfer(address,uint256), so the trailing
  // suffix bytes are ignored on execution but stay readable on-chain for
  // attribution.
  const baseData = DEGEN_IFACE.encodeFunctionData("transfer", [
    toAddress,
    ethers.parseUnits(amount.toString(), 18),
  ]);
  const data = (baseData + BUILDER_CODE_SUFFIX.slice(2)) as `0x${string}`;

  // This step is the actual money movement. If it throws, nothing was sent —
  // safe to treat as a normal failure.
  const tx = await treasury.sendTransaction({
    to: DEGEN_CONTRACT,
    data,
  });

  // From here on, the transfer has been broadcast. Any error past this point
  // does NOT mean the money didn't move — it means we're not SURE whether it
  // did. Tag the error with the hash so callers can check before retrying.
  try {
    await tx.wait();
  } catch (waitErr: any) {
    const err = new Error(
      `Transfer broadcast (tx ${tx.hash}) but confirmation failed: ${waitErr?.reason ?? waitErr?.shortMessage ?? waitErr?.message ?? waitErr}. ` +
      `The DEGEN may already have been sent — verify tx ${tx.hash} on Basescan before retrying.`
    );
    (err as any).broadcastTxHash = tx.hash;
    (err as any).originalError = waitErr;
    throw err;
  }

  console.log(`[referral] sent ${amount} DEGEN to ${toAddress} tx=${tx.hash}`);
  return tx.hash;
}

// Look up a Farcaster user's verified Base/ETH wallet via Neynar.
// Returns the first verified eth address, or custody address as fallback.
export async function getWalletFromNeynar(
  fid: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      {
        headers: {
          "x-api-key": process.env.NEYNAR_API_KEY!,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) {
      console.error(`[referral] Neynar error ${res.status}`);
      return null;
    }
    const data = await res.json();
    const user = data.users?.[0];
    if (!user) return null;

    const verified = user.verified_addresses?.eth_addresses?.[0];
    const custody = user.custody_address;
    return verified ?? custody ?? null;
  } catch (err) {
    console.error("[referral] getWalletFromNeynar failed:", err);
    return null;
  }
}

// Logs a completed DEGEN payout to the shared txn log. Used by both the
// real referral join flow and the checkin bonus flow.
export async function logDegenTxn(entry: {
  fid: number | string;
  toFid: number | string;
  type: "referral_join" | "referral_checkin";
  txHash: string;
  amountDegen: number;
  toWallet: string;
}): Promise<void> {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "https://grub-app-eight.vercel.app"}/api/txn-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fid: entry.fid,
        type: entry.type,
        txHash: entry.txHash,
        amountUsd: 0, // DEGEN not USD
        amountDegen: entry.amountDegen,
        toFid: entry.toFid,
        toWallet: entry.toWallet,
        ts: Date.now(),
      }),
    });
  } catch { /* non-blocking */ }
}

// Whole-DEGEN amount for a fresh referral join right now — 10 during the
// Referral Festival window, 1 otherwise. Shared so the real join route and
// the admin test-payout path never drift out of sync on the amount.
//
// Festival: 30 Jun–2 Jul 2026 (IST = UTC+5:30). Using UTC dates: festival
// runs 29 Jun 18:30 UTC → 2 Jul 18:29 UTC, which maps to 30 Jun 00:00 IST →
// 2 Jul 23:59 IST.
export function getReferralJoinAmount(): number {
  const nowUtc = Date.now();
  const FESTIVAL_START = Date.UTC(2026, 5, 29, 18, 30);
  const FESTIVAL_END   = Date.UTC(2026, 6, 2,  18, 30);
  const isFestival = nowUtc >= FESTIVAL_START && nowUtc < FESTIVAL_END;
  return isFestival ? 10 : 1;
}

export type RegisterReferralResult =
  | { ok: false; reason: string }
  | { ok: true; rewarded: false; reason: string; isNewJoiner: true }
  | { ok: true; rewarded: true; txHash: string; isNewJoiner: true };

// The full real "someone joined via a referral link" flow: validates the
// pair, writes the referral relationship to KV, looks up the referrer's
// wallet, and pays out the join bonus (festival-aware) with attribution.
//
// This is the SAME logic /api/referral/register runs for a genuine referral
// click — factored out here so the admin dashboard's "Set Sponsor" action
// can optionally trigger a real, fully-paid test join without needing a
// second device/wallet to click an actual ?ref= link.
export async function registerReferral(
  newUserFID: number,
  referrerFID: number
): Promise<RegisterReferralResult> {
  if (newUserFID === referrerFID) {
    return { ok: false, reason: "self-referral" };
  }

  const existing = await kv.get(`ref:${newUserFID}`);
  if (existing) {
    return { ok: false, reason: "already registered" };
  }

  const existingPetState = await kv.get<any>(`grub:pet:${newUserFID}`);
  if (existingPetState && (existingPetState.totalCheckIns ?? 0) > 0) {
    return {
      ok: false,
      reason: "fid already has existing game activity — not eligible as a new referral",
    };
  }

  await kv.set(`ref:${newUserFID}`, String(referrerFID));
  await kv.set(`ref:${newUserFID}:checkins`, 0);
  await kv.set(`ref:${newUserFID}:status`, "joined");

  const REFERRAL_DEGEN = getReferralJoinAmount();

  const referred = (await kv.get<number[]>(`referrer:${referrerFID}:referred`)) ?? [];
  await kv.set(`referrer:${referrerFID}:referred`, [...referred, newUserFID]);

  const wallet = await getWalletFromNeynar(referrerFID);
  if (!wallet) {
    return { ok: true, rewarded: false, reason: "no wallet", isNewJoiner: true };
  }

  await kv.set(`ref:${referrerFID}:wallet`, wallet);

  const lockKey = `ref:${newUserFID}:joinlock`;
  const gotLock = await acquireLock(lockKey, 30);
  if (!gotLock) {
    return {
      ok: true,
      rewarded: false,
      reason: "payout already in progress elsewhere — try again shortly",
      isNewJoiner: true,
    };
  }

  try {
    let txHash: string;
    try {
      txHash = await sendDegen(wallet, REFERRAL_DEGEN);
    } catch (err: any) {
      console.error("[referral] registerReferral sendDegen failed:", err);
      await recordFailedPayout({
        fid: referrerFID,
        toFid: newUserFID,
        toWallet: wallet,
        amountDegen: REFERRAL_DEGEN,
        type: "referral_join",
        reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error",
        broadcastTxHash: err?.broadcastTxHash ?? null,
        sideEffect: null,
      });
      return {
        ok: true,
        rewarded: false,
        reason: "DEGEN payout failed — logged for retry in dashboard",
        isNewJoiner: true,
      };
    }

    await logDegenTxn({
      fid: referrerFID,
      toFid: newUserFID,
      type: "referral_join",
      txHash,
      amountDegen: REFERRAL_DEGEN,
      toWallet: wallet,
    });

    return { ok: true, rewarded: true, txHash, isNewJoiner: true };
  } finally {
    await releaseLock(lockKey);
  }
}

// The Base App (wallet-based) equivalent of registerReferral above. Kept as
// a separate function rather than branching inside registerReferral so the
// two identity models never share a code path that could accidentally cross
// fid and wallet semantics — same reasoning as the notifications split.
//
// KV keys use a distinct "refbase:" / "referrerbase:" prefix throughout so
// there's no possibility of a Base entry colliding with (or being mistaken
// for) an fid-keyed entry, even though in practice fid (numeric) and wallet
// (0x-prefixed hex) strings would never collide anyway.
//
// One simplification vs the FC path: there's no Neynar wallet lookup step.
// On Base, the referrer's own wallet address already IS their payout
// address — nothing to resolve.
export async function registerReferralBase(
  newUserWallet: string,
  referrerWallet: string,
): Promise<RegisterReferralResult> {
  const newUser = newUserWallet.toLowerCase();
  const referrer = referrerWallet.toLowerCase();

  if (newUser === referrer) {
    return { ok: false, reason: "self-referral" };
  }

  const existing = await kv.get(`refbase:${newUser}`);
  if (existing) {
    return { ok: false, reason: "already registered" };
  }

  // Same "not eligible if this identity already has real activity" guard as
  // the FC path — uses the shared petKey() so this reads the actual wallet
  // pet-state key format instead of a hand-guessed one.
  const existingPetState = await kv.get<any>(petKey(null, newUser)!);
  if (existingPetState && (existingPetState.totalCheckIns ?? 0) > 0) {
    return {
      ok: false,
      reason: "wallet already has existing game activity — not eligible as a new referral",
    };
  }

  await kv.set(`refbase:${newUser}`, referrer);
  await kv.set(`refbase:${newUser}:checkins`, 0);
  await kv.set(`refbase:${newUser}:status`, "joined");

  const REFERRAL_DEGEN = getReferralJoinAmount();

  const referred = (await kv.get<string[]>(`referrerbase:${referrer}:referred`)) ?? [];
  await kv.set(`referrerbase:${referrer}:referred`, [...referred, newUser]);

  const lockKey = `refbase:${newUser}:joinlock`;
  const gotLock = await acquireLock(lockKey, 30);
  if (!gotLock) {
    return {
      ok: true,
      rewarded: false,
      reason: "payout already in progress elsewhere — try again shortly",
      isNewJoiner: true,
    };
  }

  try {
    let txHash: string;
    try {
      txHash = await sendDegen(referrer, REFERRAL_DEGEN);
    } catch (err: any) {
      console.error("[referral] registerReferralBase sendDegen failed:", err);
      await recordFailedPayout({
        fid: `wallet:${referrer}`,
        toFid: `wallet:${newUser}`,
        toWallet: referrer,
        amountDegen: REFERRAL_DEGEN,
        type: "referral_join",
        reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error",
        broadcastTxHash: err?.broadcastTxHash ?? null,
        sideEffect: null,
      });
      return {
        ok: true,
        rewarded: false,
        reason: "DEGEN payout failed — logged for retry in dashboard",
        isNewJoiner: true,
      };
    }

    await logDegenTxn({
      fid: `wallet:${referrer}`,
      toFid: `wallet:${newUser}`,
      type: "referral_join",
      txHash,
      amountDegen: REFERRAL_DEGEN,
      toWallet: referrer,
    });

    return { ok: true, rewarded: true, txHash, isNewJoiner: true };
  } finally {
    await releaseLock(lockKey);
  }
}


// Returns a map of fid → { username, pfp }
export async function getUsernamesFromNeynar(
  fids: number[]
): Promise<Record<number, { username: string; pfp: string }>> {
  if (fids.length === 0) return {};
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fids.join(",")}`,
      {
        headers: {
          "x-api-key": process.env.NEYNAR_API_KEY!,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const map: Record<number, { username: string; pfp: string }> = {};
    for (const user of data.users ?? []) {
      map[user.fid] = {
        username: user.username ?? `fid:${user.fid}`,
        pfp: user.pfp_url ?? "",
      };
    }
    return map;
  } catch (err) {
    console.error("[referral] getUsernamesFromNeynar failed:", err);
    return {};
  }
}

// Bulk-resolve Basenames for multiple wallet addresses in one call — the
// Base-side equivalent of getUsernamesFromNeynar above. Uses OnchainKit's
// getNames(), which does the same single-call-per-list-load bulk lookup
// shape as the Neynar call (not a per-user-per-pageview hit). Falls back to
// a shortened address (0xabcd...wxyz) per-wallet if it has no Basename, or
// if the resolution call fails entirely — never leaves a wallet unlabeled.
function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function getBasenamesForWallets(
  wallets: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (wallets.length === 0) return map;

  try {
    const names = await getNames({
      addresses: wallets as `0x${string}`[],
      chain: base,
    });
    wallets.forEach((w, i) => {
      map[w] = names[i] || shortenAddress(w);
    });
  } catch (err) {
    console.error("[referral] getBasenamesForWallets failed:", err);
    wallets.forEach((w) => {
      map[w] = shortenAddress(w);
    });
  }

  return map;
}
