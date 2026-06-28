// app/api/referral/register/route.ts
//
// Called when a new user opens the app via a referral link (?ref=<FID>).
// - Stores the referral relationship in Redis
// - Sends 1 DEGEN to the referrer immediately via treasury wallet

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendDegen, getWalletFromNeynar } from "@/lib/referral";

export async function POST(req: NextRequest) {
  try {
    const { newUserFID, referrerFID } = await req.json();

    if (!newUserFID || !referrerFID) {
      return NextResponse.json({ ok: false, reason: "missing fids" }, { status: 400 });
    }

    // Prevent self-referral
    if (Number(newUserFID) === Number(referrerFID)) {
      return NextResponse.json({ ok: false, reason: "self-referral" });
    }

    // Check if this user was already referred — only reward once
    const existing = await kv.get(`ref:${newUserFID}`);
    if (existing) {
      return NextResponse.json({ ok: false, reason: "already registered" });
    }

    // Store referral relationship
    await kv.set(`ref:${newUserFID}`, String(referrerFID));
    await kv.set(`ref:${newUserFID}:checkins`, 0);
    await kv.set(`ref:${newUserFID}:status`, "joined");

    // Maintain reverse index so referrer can see all their referrals
    const referred = await kv.get<number[]>(`referrer:${referrerFID}:referred`) ?? [];
    await kv.set(`referrer:${referrerFID}:referred`, [...referred, Number(newUserFID)]);

    // Get referrer wallet (Neynar lookup) — cache it in Redis for later
    const wallet = await getWalletFromNeynar(Number(referrerFID));
    if (!wallet) {
      console.error(`[referral/register] no wallet found for FID ${referrerFID}`);
      return NextResponse.json({ ok: true, rewarded: false, reason: "no wallet" });
    }

    await kv.set(`ref:${referrerFID}:wallet`, wallet);

    // Send 1 DEGEN immediately for the new join
    const txHash = await sendDegen(wallet, 1);

    return NextResponse.json({ ok: true, rewarded: true, txHash });
  } catch (err: any) {
    console.error("[referral/register] error:", err);
    return NextResponse.json(
      { ok: false, reason: err?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}
