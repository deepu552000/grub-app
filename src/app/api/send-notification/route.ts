// app/api/send-notification/route.ts
//
// Manual/triggered single-user notification, e.g. call this from your own
// game logic when Grub goes feral, or for testing.
//
// POST body: {
//   fid?: number,            // Farcaster — unchanged from before
//   walletAddress?: string,  // Base App — new, independent of fid
//   title: string,
//   body: string,
//   targetUrl?: string,      // FC deep link, must match manifest domain
//   targetPath?: string,     // Base in-app path, e.g. "/rewards" (must start with "/")
// }
// At least one of fid / walletAddress is required. You can pass both to hit
// the same user on both platforms in one call.
//
// Protect this route in production — anyone who can call it can spam your
// users. The check below uses a simple shared-secret header; swap for your
// own auth if you have something better.

import { NextRequest, NextResponse } from "next/server";
import { sendNotificationToUser } from "@/lib/send-notification";
import { sendNotificationToWalletBase } from "@/lib/send-notification-base";

// The Farcaster app's own FID — used to scope tokens. Replace if your
// manifest's accountAssociation custody fid differs; this is your app's
// identity, set once.
const APP_FID = 9152;

const APP_URL = "https://grub-app-eight.vercel.app";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { fid, walletAddress, title, body, targetUrl, targetPath } = await request.json();

  if (!fid && !walletAddress) {
    return NextResponse.json(
      { error: "fid or walletAddress is required" },
      { status: 400 },
    );
  }

  if (!title || !body) {
    return NextResponse.json(
      { error: "title and body are required" },
      { status: 400 },
    );
  }

  let fcResult: Awaited<ReturnType<typeof sendNotificationToUser>> | null = null;
  let baseResult: Awaited<ReturnType<typeof sendNotificationToWalletBase>> | null = null;

  // Farcaster (fid-based) — identical to the original implementation.
  if (fid) {
    console.log(`[send-notification] fc → fid=${fid} title="${title}"`);

    fcResult = await sendNotificationToUser(fid, APP_FID, {
      notificationId: `grub-alert-${fid}-${Date.now()}`,
      title: title.slice(0, 32),
      body: body.slice(0, 128),
      targetUrl: targetUrl ?? APP_URL,
    });

    console.log(`[send-notification] fc ← fid=${fid} result=${JSON.stringify(fcResult)}`);
  }

  // Base App (wallet-based) — new, runs independently of the fid path above.
  if (walletAddress) {
    console.log(`[send-notification] base → address=${walletAddress} title="${title}"`);

    baseResult = await sendNotificationToWalletBase(APP_URL, walletAddress, {
      title,
      message: body,
      targetPath,
    });

    console.log(`[send-notification] base ← address=${walletAddress} result=${JSON.stringify(baseResult)}`);
  }

  // Keep the original single-result response shape when only one platform
  // was targeted — this is the existing fid-only contract every current
  // caller relies on. Only wrap into { fc, base } when both were sent.
  if (fcResult && baseResult) {
    return NextResponse.json({ fc: fcResult, base: baseResult });
  }
  return NextResponse.json(fcResult ?? baseResult);
}
