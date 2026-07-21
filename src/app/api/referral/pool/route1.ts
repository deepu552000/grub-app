// app/api/referral/pool/route.ts
// Returns current DEGEN balance of the treasury wallet (the referral reward pool)
//
// Reads the balance directly from Base via RPC (same pattern as sendDegen in
// lib/referral.ts) instead of Etherscan's API — Etherscan's free tier
// doesn't support Base (chainid 8453), it requires a paid plan. Reading
// balance directly via RPC is free and doesn't depend on any third-party
// indexer being available or paid for.

import { NextResponse } from "next/server";
import { ethers } from "ethers";

const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS ?? "";
const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // DEGEN on Base
const DEGEN_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export async function GET() {
  try {
    if (!TREASURY_WALLET) {
      return NextResponse.json({
        ok: false,
        poolDegen: 0,
        error: "TREASURY_WALLET_ADDRESS env var is missing or empty",
      });
    }

    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
    );
    const contract = new ethers.Contract(DEGEN_CONTRACT, DEGEN_ABI, provider);

    const rawBalance: bigint = await contract.balanceOf(TREASURY_WALLET);

    // DEGEN uses 18 decimals — format to a normal human-readable number.
    const degen = Number(ethers.formatUnits(rawBalance, 18));

    return NextResponse.json({ ok: true, poolDegen: degen });
  } catch (err: any) {
    console.error("[referral/pool] error:", err);
    return NextResponse.json({
      ok: false,
      poolDegen: 0,
      error: err?.message ?? "unknown error",
    });
  }
}
