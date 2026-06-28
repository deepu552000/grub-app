// lib/referral.ts
//
// Shared helpers for referral payouts and wallet lookup.
// Used by /api/referral/register and /api/referral/checkin

import { ethers } from "ethers";

const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DEGEN_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];

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
