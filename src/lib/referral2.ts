// lib/referral.ts
//
// Shared helpers for referral payouts and wallet lookup.
// Used by /api/referral/register and /api/referral/checkin

import { ethers } from "ethers";
import { kv } from "@vercel/kv";

const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DEGEN_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];

const FAILED_PAYOUTS_KEY = "failed-payouts";

// A DEGEN payout that failed to send (e.g. treasury wallet ran out of DEGEN,
// RPC hiccup, bad wallet address, etc). Logged so it can be retried from the
// dashboard once the underlying issue (usually: refill the treasury) is fixed.
export type FailedPayout = {
  id: string;
  fid: number;               // the fid whose wallet was supposed to receive DEGEN
  toFid: number;              // the fid whose action triggered the payout
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
  const contract = new ethers.Contract(DEGEN_CONTRACT, DEGEN_ABI, treasury);

  // This step is the actual money movement. If it throws, nothing was sent —
  // safe to treat as a normal failure.
  const tx = await contract.transfer(
    toAddress,
    ethers.parseUnits(amount.toString(), 18)
  );

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

// Bulk lookup usernames for multiple FIDs in one Neynar call.
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
