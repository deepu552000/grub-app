// app/api/cron/checkin-reminder/route.ts
//
// Daily check-in reminder, broadcast to every user who has notifications
// enabled. Wire this up to Vercel Cron (see vercel.json below) to fire
// once a day, e.g. at 6pm UTC.
//
// Note: this sends to EVERYONE with a token, regardless of whether they
// already checked in today. If you want to only remind people who HAVEN'T
// checked in yet, you'd need to track checkin state server-side (right
// now it lives in localStorage on the client, which the server can't see).
// Simplest v1: just remind everyone daily. Smarter v2: have the client
// report check-in completion to your API so you can filter.

import { NextRequest, NextResponse } from "next/server";
import { sendNotificationToAll } from "@/lib/send-notification";

const APP_FID = 777804;
const APP_URL = "https://grub-app-eight.vercel.app";

export async function GET(request: NextRequest) {
  // Vercel Cron sends a secret bearer token when CRON_SECRET is set —
  // verify it so randoms can't trigger mass notifications by hitting this URL.
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sendNotificationToAll(APP_FID, {
    notificationId: `checkin-reminder-${new Date().toISOString().slice(0, 10)}`,
    title: "Grub is waiting 🐾",
    body: "Check in to keep your streak alive and care for Grub today.",
    targetUrl: APP_URL,
  });

  return NextResponse.json({ ok: true, ...result });
}
