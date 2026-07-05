// app/api/referral/register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { registerReferral } from "@/lib/referral";

export async function POST(req: NextRequest) {
  try {
    const { newUserFID, referrerFID } = await req.json();

    if (!newUserFID || !referrerFID) {
      return NextResponse.json({ ok: false, reason: "missing fids" }, { status: 400 });
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
