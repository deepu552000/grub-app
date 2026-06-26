// app/api/cron/hunger-alert/route.ts
//
// Combined daily cron — runs once at 9am UTC via Vercel Cron.
// 1. Sends a check-in reminder to ALL users (everyone gets a nudge)
// 2. Sends a hunger alert to users whose Grub is actually hungry (hunger < 38)
//    — skips users who already received a hunger alert today

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { sendNotificationToUser, sendNotificationToAll } from "@/lib/send-notification";

const APP_FID = 9152;
const APP_URL = "https://grub-app-eight.vercel.app";
const HUNGRY_THRESHOLD = 38;
const FERAL_THRESHOLD = 18;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

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

  const today = todayKey();
  const keys = await kv.keys("grub:pet:*");

  let hungerNotified = 0;
  let checkinNotified = 0;
  let skipped = 0;
  let alreadyAlerted = 0;

  // Track FIDs that got a hunger alert so we can exclude from checkin broadcast
  const hungryFids = new Set<number>();

  // ── 1. HUNGER ALERTS — per user, only if actually hungry ──────────────────
  for (const key of keys) {
    const state = await kv.get<any>(key);
    const fid = Number(key.replace("grub:pet:", ""));

    if (!state || !fid) { skipped++; continue; }

    const alertKey = `grub:hunger-alert:${fid}:${today}`;
    const alreadySent = await kv.get(alertKey);
    if (alreadySent) { alreadyAlerted++; hungryFids.add(fid); continue; }

    const hunger = currentHunger(state.hunger ?? 100, state.lastVisit ?? Date.now());
    if (hunger >= HUNGRY_THRESHOLD) continue; // not hungry — will get checkin reminder

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
        await kv.set(alertKey, "1", { ex: 86400 });
        hungryFids.add(fid);
        hungerNotified++;
      }
    } catch {
      skipped++;
    }
  }

  // ── 2. CHECK-IN REMINDER — only users who didn't get hunger alert ──────────
  // Build exclusion list from hungryFids
  const excludeFids = Array.from(hungryFids);

  const reminderResult = await sendNotificationToAll(APP_FID, {
    notificationId: `checkin-reminder-${today}`,
    title: "Grub is waiting 🐾",
    body: "Check in to keep your streak alive and care for Grub today.",
    targetUrl: APP_URL,
  }, excludeFids);

  checkinNotified = reminderResult?.totalSent ?? 0;

  return NextResponse.json({
    ok: true,
    hungerAlerts: { notified: hungerNotified, skipped, alreadyAlerted },
    checkinReminders: { notified: checkinNotified, excluded: excludeFids.length },
  });
}

