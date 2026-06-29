// app/api/referral/checkin/route.ts
//
// Called alongside the user's daily check-in.
// Increments their referral check-in count (non-consecutive, total only).
// When count reaches 5 → sends 2 DEGEN to referrer and closes the loop.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendDegen } from "@/lib/referral";

export async function POST(req: NextRequest) {
  try {
    const { userFID } = await req.json();

    if (!userFID) {
      return NextResponse.json({ ok: false, reason: "missing fid" }, { status: 400 });
    }

    // Check if this user was referred
    const referrerFID = await kv.get(`ref:${userFID}`);
    if (!referrerFID) {
      return NextResponse.json({ ok: false, reason: "not a referred user" });
    }

    // Check if already paid out — loop is closed
    const status = await kv.get(`ref:${userFID}:status`);
    if (status === "paid") {
      return NextResponse.json({ ok: false, reason: "already paid" });
    }

    // Increment total check-in count (not consecutive — any 5 check-ins)
    const count = await kv.incr(`ref:${userFID}:checkins`);
    console.log(`[referral/checkin] FID ${userFID} checkin count: ${count}`);

    // Not at 5 yet — just update count
    if (count < 5) {
      return NextResponse.json({ ok: true, checkins: count, paid: false });
    }

    // Reached 5 check-ins — pay out referrer
    const wallet = await kv.get<string>(`ref:${referrerFID}:wallet`);
    if (!wallet) {
      console.error(`[referral/checkin] no wallet cached for referrer FID ${referrerFID}`);
      return NextResponse.json({ ok: false, reason: "referrer wallet not found" });
    }

    const txHash = await sendDegen(wallet, 2);

    // Mark as paid — no more rewards for this referral
    await kv.set(`ref:${userFID}:status`, "paid");

    console.log(`[referral/checkin] paid 2 DEGEN to ${wallet} for referring FID ${userFID}`);
    return NextResponse.json({ ok: true, checkins: count, paid: true, txHash });
  } catch (err: any) {
    console.error("[referral/checkin] error:", err);
    return NextResponse.json(
      { ok: false, reason: err?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}
