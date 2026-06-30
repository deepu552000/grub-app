// lib/notification-tokens.ts
//
// Stores Farcaster notification tokens per (fid, appFid) so we can send
// pushes later (check-in reminders, "Grub is hungry" alerts, etc).
//
// Uses Vercel KV (Redis). Add the Vercel KV integration to your project
// (or any Redis-compatible store) and the env vars below are set for you
// automatically when you do `vercel link` + add the KV integration.
//
// npm install @vercel/kv

import { kv } from "@vercel/kv";

export type NotificationDetails = {
  url: string;
  token: string;
};

// Key is scoped per-client (appFid) since the same user FID can have
// different tokens in Farcaster vs Base App vs any other host.
function tokenKey(fid: number, appFid: number) {
  return `grub:notif:${appFid}:${fid}`;
}

// Keep a set of all fids we have tokens for, per app, so cron jobs can
// page through everyone without scanning the whole keyspace.
function fidSetKey(appFid: number) {
  return `grub:notif-fids:${appFid}`;
}

// Separate set tracking who has the app ADDED, regardless of whether
// notifications are currently on. miniapp_added fires even when the user
// declines/has no notificationDetails, so this needs its own tracking —
// it must NOT be inferred from the notif-token set.
function addedSetKey(appFid: number) {
  return `grub:added-fids:${appFid}`;
}

// Raw audit log of every webhook event received, newest first. Capped at
// the last 500 entries so it doesn't grow forever. This is our paper trail
// since Vercel's free-tier log retention is too short to rely on, and we
// don't have a log drain integration (requires Pro).
const EVENT_LOG_KEY = "grub:events:log";
const EVENT_LOG_MAX = 2000;

export type WebhookLogEntry = {
  ts: number;
  appFid: number;
  fid: number;
  event: string;
  payload: any;
};

export async function logWebhookEvent(
  appFid: number,
  fid: number,
  eventType: string,
  payload: any,
) {
  const entry: WebhookLogEntry = { ts: Date.now(), appFid, fid, event: eventType, payload };
  await kv.lpush(EVENT_LOG_KEY, JSON.stringify(entry));
  await kv.ltrim(EVENT_LOG_KEY, 0, EVENT_LOG_MAX - 1);
}

export async function getWebhookEventLog(limit = 100): Promise<WebhookLogEntry[]> {
  const raw = await kv.lrange<string>(EVENT_LOG_KEY, 0, limit - 1);
  return (raw ?? [])
    .map((r) => {
      try {
        return typeof r === "string" ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter((e): e is WebhookLogEntry => e !== null);
}

export async function markAppAdded(fid: number, appFid: number) {
  await kv.sadd(addedSetKey(appFid), fid);
}

export async function unmarkAppAdded(fid: number, appFid: number) {
  await kv.srem(addedSetKey(appFid), fid);
}

export async function getAllAddedFids(appFid: number): Promise<number[]> {
  const fids = await kv.smembers(addedSetKey(appFid));
  return (fids ?? []).map((f) => Number(f));
}

export async function saveNotificationDetails(
  fid: number,
  appFid: number,
  details: NotificationDetails,
) {
  await kv.set(tokenKey(fid, appFid), details);
  await kv.sadd(fidSetKey(appFid), fid);
}

export async function removeNotificationDetails(fid: number, appFid: number) {
  await kv.del(tokenKey(fid, appFid));
  await kv.srem(fidSetKey(appFid), fid);
}

export async function getNotificationDetails(
  fid: number,
  appFid: number,
): Promise<NotificationDetails | null> {
  const result = await kv.get<NotificationDetails>(tokenKey(fid, appFid));
  return result ?? null;
}

export async function getAllFidsForApp(appFid: number): Promise<number[]> {
  const fids = await kv.smembers(fidSetKey(appFid));
  return (fids ?? []).map((f) => Number(f));
}

// Convenience: fetch every stored token for an app, paired with its fid.
// Used by the check-in reminder cron to batch-send to everyone.
export async function getAllNotificationDetailsForApp(
  appFid: number,
): Promise<{ fid: number; details: NotificationDetails }[]> {
  const fids = await getAllFidsForApp(appFid);
  if (fids.length === 0) return [];

  const results = await Promise.all(
    fids.map(async (fid) => {
      const details = await getNotificationDetails(fid, appFid);
      return details ? { fid, details } : null;
    }),
  );

  return results.filter((r): r is { fid: number; details: NotificationDetails } => r !== null);
}
