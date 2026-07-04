// app/api/debug-base-notifications/route.ts
//
// TEMPORARY diagnostic route — delete once notification delivery is
// confirmed working. Lists the exact wallet addresses Base's Notifications
// API currently reports as opted-in for this app, so you can compare
// against your own test wallet address (case, format, which account).
//
// GET with header x-internal-secret matching NOTIFICATION_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { getOptedInWallets, getWalletNotificationStatus } from "@/lib/send-notification-base";

const APP_URL = "https://grub-app-eight.vercel.app";

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional: ?address=0x... to check one specific wallet's status directly,
  // in addition to the full opted-in list.
  const checkAddress = request.nextUrl.searchParams.get("address");

  try {
    const optedIn = await getOptedInWallets(APP_URL);

    let addressStatus = null;
    if (checkAddress) {
      addressStatus = await getWalletNotificationStatus(APP_URL, checkAddress);
    }

    return NextResponse.json({
      appUrl: APP_URL,
      optedInCount: optedIn.length,
      optedInWallets: optedIn,
      checkedAddress: checkAddress
        ? { address: checkAddress, status: addressStatus }
        : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "failed" }, { status: 500 });
  }
}
