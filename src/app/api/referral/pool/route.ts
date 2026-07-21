// app/api/referral/pool/route.ts
// Returns current DEGEN + USDC balance of the treasury wallet.
//
// Reads both balances directly from Base via RPC (same pattern as sendDegen in
// lib/referral.ts) instead of Etherscan's API — Etherscan's free tier
// doesn't support Base (chainid 8453), it requires a paid plan. Reading
// balance directly via RPC is free and doesn't depend on any third-party
// indexer being available or paid for.

import { NextResponse } from "next/server";
import { ethers } from "ethers";

const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS ?? "";
const DEGEN_CONTRACT = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // DEGEN on Base
// USDC on Base mainnet — same contract Client.tsx's sendUsdcPayment() pays
// into (checkin/accessory/wheel/raffle all land here), so this is the same
// pool that's being drawn down by every USDC-priced feature.
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export async function GET() {
  try {
    if (!TREASURY_WALLET) {
      return NextResponse.json({
        ok: false,
        poolDegen: 0,
        poolUsdc: 0,
        error: "TREASURY_WALLET_ADDRESS env var is missing or empty",
      });
    }

    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
    );
    const degenContract = new ethers.Contract(DEGEN_CONTRACT, ERC20_ABI, provider);
    const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);

    // Fetch both in parallel — independent reads, no reason to serialize them.
    const [rawDegen, rawUsdc] = await Promise.all([
      degenContract.balanceOf(TREASURY_WALLET) as Promise<bigint>,
      usdcContract.balanceOf(TREASURY_WALLET) as Promise<bigint>,
    ]);

    // DEGEN uses 18 decimals, USDC uses 6 — format each to a normal
    // human-readable number.
    const degen = Number(ethers.formatUnits(rawDegen, 18));
    const usdc = Number(ethers.formatUnits(rawUsdc, 6));

    return NextResponse.json({ ok: true, poolDegen: degen, poolUsdc: usdc });
  } catch (err: any) {
    console.error("[referral/pool] error:", err);
    return NextResponse.json({
      ok: false,
      poolDegen: 0,
      poolUsdc: 0,
      error: err?.message ?? "unknown error",
    });
  }
}
