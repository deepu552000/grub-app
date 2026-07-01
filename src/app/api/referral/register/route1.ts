// app/api/referral/register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendDegen, getWalletFromNeynar } from "@/lib/referral";

async function logDegenTxn(entry: {
  fid: number;
  toFid: number;
  type: "referral_join" | "referral_checkin";
  txHash: string;
  amountDegen: number;
  toWallet: string;
}) {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "https://grub-app-eight.vercel.app"}/api/txn-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fid: entry.fid,
        type: entry.type,
        txHash: entry.txHash,
        amountUsd: 0, // DEGEN not USD
        amountDegen: entry.amountDegen,
        toFid: entry.toFid,
        toWallet: entry.toWallet,
        ts: Date.now(),
      }),
    });
  } catch { /* non-blocking */ }
}

export async function POST(req: NextRequest) {
  try {
    const { newUserFID, referrerFID } = await req.json();

    if (!newUserFID || !referrerFID) {
      return NextResponse.json({ ok: false, reason: "missing fids" }, { status: 400 });
    }

    if (Number(newUserFID) === Number(referrerFID)) {
      return NextResponse.json({ ok: false, reason: "self-referral" });
    }

    const existing = await kv.get(`ref:${newUserFID}`);
    if (existing) {
      return NextResponse.json({ ok: false, reason: "already registered" });
    }

    const existingPetState = await kv.get<any>(`grub:pet:${newUserFID}`);
    if (existingPetState && (existingPetState.totalCheckIns ?? 0) > 0) {
      return NextResponse.json({
        ok: false,
        reason: "fid already has existing game activity — not eligible as a new referral",
      });
    }

    await kv.set(`ref:${newUserFID}`, String(referrerFID));
    await kv.set(`ref:${newUserFID}:checkins`, 0);
    await kv.set(`ref:${newUserFID}:status`, "joined");

    // ── Referral Festival: 30 Jun–2 Jul 2026 (IST = UTC+5:30) ──────────────
    // Using UTC dates: festival runs 29 Jun 18:30 UTC → 2 Jul 18:29 UTC
    // which maps to 30 Jun 00:00 IST → 2 Jul 23:59 IST
    const nowUtc = Date.now();
    const FESTIVAL_START = Date.UTC(2026, 5, 29, 18, 30); // 30 Jun 00:00 IST
    const FESTIVAL_END   = Date.UTC(2026, 6, 2,  18, 30); // 2 Jul 23:59 IST
    const isFestival = nowUtc >= FESTIVAL_START && nowUtc < FESTIVAL_END;
    const REFERRAL_DEGEN = isFestival ? 10 : 1;
    // ────────────────────────────────────────────────────────────────────────

    const referred = await kv.get<number[]>(`referrer:${referrerFID}:referred`) ?? [];
    await kv.set(`referrer:${referrerFID}:referred`, [...referred, Number(newUserFID)]);

    const wallet = await getWalletFromNeynar(Number(referrerFID));
    if (!wallet) {
      return NextResponse.json({ ok: true, rewarded: false, reason: "no wallet", isNewJoiner: true });
    }

    await kv.set(`ref:${referrerFID}:wallet`, wallet);

    const txHash = await sendDegen(wallet, REFERRAL_DEGEN);

    // Log the DEGEN payout
    await logDegenTxn({
      fid: Number(referrerFID),
      toFid: Number(newUserFID),
      type: "referral_join",
      txHash,
      amountDegen: REFERRAL_DEGEN,
      toWallet: wallet,
    });

    return NextResponse.json({ ok: true, rewarded: true, txHash, isNewJoiner: true });
  } catch (err: any) {
    console.error("[referral/register] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
