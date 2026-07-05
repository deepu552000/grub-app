// app/api/referral/register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { registerReferral, registerReferralBase } from "@/lib/referral";

export async function POST(req: NextRequest) {
  try {
    const { newUserFID, referrerFID, newUserWallet, referrerWallet } = await req.json();

    // Base App (wallet-based) — new, completely separate from the fid path
    // below. Only runs if wallet fields are present instead of fid fields.
    if (newUserWallet && referrerWallet) {
      const result = await registerReferralBase(newUserWallet, referrerWallet);
      return NextResponse.json(result);
    }

    if (!newUserFID || !referrerFID) {
      return NextResponse.json({ ok: false, reason: "missing fids or wallets" }, { status: 400 });
    }

    // All the actual logic (self-referral check, already-registered check,
    // KV writes, festival-aware amount, wallet lookup, lock, sendDegen,
    // logging) lives in registerReferral() in lib/referral.ts — shared with
    // the admin dashboard's "Set Sponsor + trigger payout" test path so both
    // ways of registering a referral behave identically.
    const result = await registerReferral(Number(newUserFID), Number(referrerFID));
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[referral/register] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
