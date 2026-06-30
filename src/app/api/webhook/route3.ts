// app/api/webhook/route.ts
//
// Receives the 4 Farcaster Mini App server events:
//   miniapp_added, miniapp_removed, notifications_enabled, notifications_disabled
//
// Farcaster/Base App POST signed events here whenever a user adds Grub,
// removes it, or toggles notifications. We verify the signature with
// Neynar, then save/remove the notification token accordingly.
//
// Requires: npm install @farcaster/miniapp-node
// Env var: NEYNAR_API_KEY (free tier at neynar.com)
//
// IMPORTANT (Base App specific): Base App waits for a successful webhook
// response before activating the token, while Farcaster activates tokens
// immediately. So this handler must respond quickly (under 10s) — we do
// the KV write inline since it's fast, but avoid adding slow work here.

import { NextRequest, NextResponse } from "next/server";
import {
  parseWebhookEvent,
  verifyAppKeyWithNeynar,
} from "@farcaster/miniapp-node";
import {
  saveNotificationDetails,
  removeNotificationDetails,
  markAppAdded,
  unmarkAppAdded,
  logWebhookEvent,
} from "@/lib/notification-tokens";

export async function POST(request: NextRequest) {
  const body = await request.json();

  let data: Awaited<ReturnType<typeof parseWebhookEvent>>;
  try {
    data = await parseWebhookEvent(body, verifyAppKeyWithNeynar);
  } catch (err: any) {
    // Signature invalid / malformed payload — reject, don't process.
    const message = err?.message ?? "Invalid webhook event";
    console.error("Webhook verification failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 401 });
  }

  const { fid, event } = data;
  const appFid = data.appFid;
  console.log("appFid received:", appFid, "fid:", fid);

  // Audit log — fire and forget, never let logging failures block the
  // webhook response (Base App needs this fast, see note above).
  logWebhookEvent(appFid, fid, event.event, body).catch((err) =>
    console.error("Failed to write webhook event log:", err),
  );

  switch (event.event) {
    case "miniapp_added": {
      // Always record the add — this must happen whether or not
      // notificationDetails came with it (user may have declined notifs
      // while still adding the app).
      await markAppAdded(fid, appFid);
      if (event.notificationDetails) {
        await saveNotificationDetails(fid, appFid, event.notificationDetails);
      }
      break;
    }

    case "miniapp_removed": {
      await unmarkAppAdded(fid, appFid);
      await removeNotificationDetails(fid, appFid);
      break;
    }

    case "notifications_enabled": {
      await saveNotificationDetails(fid, appFid, event.notificationDetails);
      break;
    }

    case "notifications_disabled": {
      await removeNotificationDetails(fid, appFid);
      break;
    }

    default:
      // Unknown event type — acknowledge anyway so the client doesn't retry forever.
      break;
  }

  return NextResponse.json({ success: true });
}
