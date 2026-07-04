// app/api/send-notification-all/route.ts
//
// Broadcast to everyone who has notifications enabled — Farcaster clients
// AND Base App, in one call. The two platforms are fetched/sent completely
// independently: a Base API outage never blocks or breaks the FC broadcast.
//
// POST body: {
//   title: string,
//   body: string,
//   targetUrl?: string,          // FC deep link, defaults to APP_URL
//   targetPath?: string,         // Base in-app path e.g. "/rewards"
//   excludeFids?: number[],      // FC fids to skip (unchanged from before)
//   excludeAddresses?: string[], // Base wallet addresses to skip (new)
// }

import { NextRequest, NextResponse } from "next/server";
import { sendNotificationToAll } from "@/lib/send-notification";
import { sendNotificationToAllBase } from "@/lib/send-notification-base";

const APP_FID = 9152;
const APP_URL = "https://grub-app-eight.vercel.app";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");

  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    title,
    body,
    targetUrl,
    targetPath,
    excludeFids,
    excludeAddresses,
  } = await request.json();

  if (!title || !body) {
    return NextResponse.json(
      { error: "title and body are required" },
      { status: 400 }
    );
  }

  console.log(`[send-notification-all] → title="${title}" body="${body}"`);

  // Farcaster (fid-based) broadcast — untouched from the original.
  const fcResult = await sendNotificationToAll(
    APP_FID,
    {
      notificationId: `grub-broadcast-${Date.now()}`,
      title: title.slice(0, 32),
      body: body.slice(0, 128),
      targetUrl: targetUrl ?? APP_URL,
    },
    excludeFids ?? [],
  );

  console.log(`[send-notification-all] fc ← result=${JSON.stringify(fcResult)}`);

  // Base App (wallet-based) broadcast — new, additive. Wrapped so that a
  // failure here (e.g. Base API down) can never take down the FC result
  // above or fail the whole request.
  let baseResult: { totalSent: number; totalFailed: number } = {
    totalSent: 0,
    totalFailed: 0,
  };
  try {
    baseResult = await sendNotificationToAllBase(
      APP_URL,
      { title, message: body, targetPath },
      excludeAddresses ?? [],
    );
    console.log(`[send-notification-all] base ← result=${JSON.stringify(baseResult)}`);
  } catch (err) {
    console.error("[send-notification-all] base broadcast failed:", err);
  }

  return NextResponse.json({ fc: fcResult, base: baseResult });
}
