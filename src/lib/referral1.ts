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

// Send DEGEN from treasury wallet to a recipient address.
// amount = whole DEGEN units (e.g. 1 or 2)
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
  const tx = await contract.transfer(
    toAddress,
    ethers.parseUnits(amount.toString(), 18)
  );
  await tx.wait();
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
