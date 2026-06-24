// app/api/send-notification/route.ts
//
// Manual/triggered single-user notification, e.g. call this from your own
// game logic when Grub goes feral, or for testing.
//
// POST body: { fid: number, title: string, body: string, targetUrl?: string }
//
// Protect this route in production — anyone who can call it can spam your
// users. The check below uses a simple shared-secret header; swap for your
// own auth if you have something better.

import { NextRequest, NextResponse } from "next/server";
import { sendNotificationToUser } from "@/lib/send-notification";

// The Farcaster app's own FID — used to scope tokens. Replace if your
// manifest's accountAssociation custody fid differs; this is your app's
// identity, set once.
const APP_FID = 777804;

const APP_URL = "https://grub-app-eight.vercel.app";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { fid, title, body, targetUrl } = await request.json();

  if (!fid || !title || !body) {
    return NextResponse.json(
      { error: "fid, title, and body are required" },
      { status: 400 },
    );
  }

  const result = await sendNotificationToUser(fid, APP_FID, {
    notificationId: `grub-alert-${fid}-${Date.now()}`,
    title: title.slice(0, 32),
    body: body.slice(0, 128),
    targetUrl: targetUrl ?? APP_URL,
  });

  return NextResponse.json(result);
}
