// app/api/referral/pool/route.ts
// Returns current DEGEN balance of the treasury wallet (the referral reward pool)

import { NextResponse } from "next/server";

const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS ?? "";
const DEGEN_CONTRACT  = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"; // DEGEN on Base

export async function GET() {
  try {
    // Etherscan v2 — ERC-20 token balance for treasury wallet on Base
    const url = `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=tokenbalance&contractaddress=${DEGEN_CONTRACT}&address=${TREASURY_WALLET}&tag=latest&apikey=${process.env.BASESCAN_API_KEY ?? ""}`;

    const res  = await fetch(url, { cache: "no-store" });
    const json = await res.json();

    // Result is in wei (18 decimals for DEGEN)
    const raw = BigInt(json?.result ?? "0");
    const degen = Number(raw / BigInt(1e18));

    return NextResponse.json({ ok: true, poolDegen: degen });
  } catch (err: any) {
    return NextResponse.json({ ok: false, poolDegen: 0, error: err?.message });
  }
}
