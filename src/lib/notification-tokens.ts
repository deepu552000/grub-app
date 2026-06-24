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
