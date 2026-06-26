// app/api/cron/hunger-alert/route.ts
//
// Smart hunger notification — runs every 2 hours via Vercel Cron.
// Reads each user's pet state from Redis, calculates current hunger
// (applying the same time-decay logic as the client), and sends a
// notification only if Grub is actually hungry (hunger < 38).
//
// Skips users who already received a hunger alert today so we don't
// spam them multiple times in one day.
//
// vercel.json entry:
// { "path": "/api/cron/hunger-alert", "schedule": "0 */2 * * *" }

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendNotificationToUser } from "@/lib/send-notification";

const APP_FID = 9152;
const APP_URL = "https://grub-app-eight.vercel.app";
const HUNGRY_THRESHOLD = 38;  // same as client moodFor()
const FERAL_THRESHOLD = 18;   // below this = feral

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Mirror of client-side hunger decay logic
function currentHunger(savedHunger: number, lastVisit: number): number {
  const hoursAway = Math.max(0, (Date.now() - lastVisit) / 36e5);
  const decayed = savedHunger - hoursAway * 3;
  return Math.max(0, Math.min(100, Math.round(decayed)));
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all pet keys from Redis
  const keys = await kv.keys("grub:pet:*");
  if (keys.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, notified: 0 });
  }

  const today = todayKey();
  let notified = 0;
  let skipped = 0;
  let alreadyAlerted = 0;

  for (const key of keys) {
    const state = await kv.get<any>(key);
    const fid = Number(key.replace("grub:pet:", ""));

    if (!state || !fid) { skipped++; continue; }

    // Skip if already sent hunger alert today
    const alertKey = `grub:hunger-alert:${fid}:${today}`;
    const alreadySent = await kv.get(alertKey);
    if (alreadySent) { alreadyAlerted++; continue; }

    // Calculate actual current hunger with time decay
    const hunger = currentHunger(state.hunger ?? 100, state.lastVisit ?? Date.now());

    // Only notify if truly hungry or feral
    if (hunger >= HUNGRY_THRESHOLD) { skipped++; continue; }

    const isFeral = hunger < FERAL_THRESHOLD;
    const title = isFeral ? "Grub has gone feral 😾" : "Grub is hungry 🍼";
    const body = isFeral
      ? "You've been away too long. Grub needs you urgently!"
      : "Grub's bowl is empty. Come back and feed her before she goes feral!";

    try {
      const result = await sendNotificationToUser(fid, APP_FID, {
        notificationId: `hunger-alert-${fid}-${today}`,
        title,
        body,
        targetUrl: APP_URL,
      });

      if (result.sent) {
        // Mark as alerted today so we don't send again
        await kv.set(alertKey, "1", { ex: 86400 }); // expires in 24h
        notified++;
      }
    } catch {
      skipped++;
    }
  }

  return NextResponse.json({
    ok: true,
    checked: keys.length,
    notified,
    skipped,
    alreadyAlerted,
  });
}
