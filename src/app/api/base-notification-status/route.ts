// app/api/base-notification-status/route.ts
//
// Client-facing check: "does Base think this wallet has notifications
// enabled for Grub right now?" Powers the in-app notification nudge banner
// for Base App users, who have no sdk.context.client.notificationDetails
// equivalent (that's Farcaster-only) to check client-side.
//
// Not secret-gated like the admin send/broadcast routes — this only reveals
// two booleans about a wallet address the caller already knows (their own),
// nothing another party couldn't already learn by checking Base App's own
// UI. Result is cached for 5 minutes server-side (see
// getWalletNotificationStatusCached) to stay well under Base's shared
// 20 req/min rate limit as real user traffic scales up.

import { NextRequest, NextResponse } from "next/server";
import { getWalletNotificationStatusCached } from "@/lib/send-notification-base";

const APP_URL = "https://grub-app-eight.vercel.app";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "valid wallet address is required" }, { status: 400 });
  }

  try {
    const status = await getWalletNotificationStatusCached(APP_URL, wallet);
    return NextResponse.json(status);
  } catch (err: any) {
    // Fail closed to "not enabled" rather than erroring the whole page —
    // worst case the banner shows once more than it strictly needs to.
    return NextResponse.json({ appPinned: false, notificationsEnabled: false });
  }
}
