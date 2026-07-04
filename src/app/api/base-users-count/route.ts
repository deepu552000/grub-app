// app/api/base-users-count/route.ts
//
// Returns just the count of wallet addresses currently opted in to
// notifications for the app on Base App — the Base-side equivalent of
// however you're currently counting FC fids.

import { NextRequest, NextResponse } from "next/server";
import { getOptedInWallets } from "@/lib/send-notification-base";

const APP_URL = "https://grub-app-eight.vercel.app";

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const wallets = await getOptedInWallets(APP_URL);
    return NextResponse.json({ count: wallets.length });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "failed" }, { status: 500 });
  }
}
