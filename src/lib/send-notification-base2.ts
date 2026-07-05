// lib/send-notification-base.ts
//
// Base App notification sending via the Base Dashboard REST API:
// https://docs.base.org/apps/technical-guides/base-notifications
//
// Unlike Farcaster's model, Base doesn't hand your webhook a token to store —
// their API is the source of truth for who has pinned your app and enabled
// notifications. You just ask for the current opted-in wallet list when you
// need to broadcast, and POST straight to their /send endpoint for
// single-user sends. No local storage, no webhook receiver needed here.
//
// Fully separate from lib/send-notification.ts and lib/notification-tokens.ts
// (Farcaster/fid). Nothing in this file touches those, their KV keys, or
// their APP_FID scoping — Base identifies users by wallet address, not fid.

import { kv } from "@vercel/kv";

const BASE_API = "https://dashboard.base.org/api/v1/notifications";

const MAX_ADDRESSES_PER_BATCH = 1000; // Base's documented max per /send request
const MAX_USERS_PAGE_SIZE = 500; // Base's documented max per /users page

// Notification + users endpoints share one rate limit: 20 requests/min/IP
// per Base's docs. Pace consecutive calls comfortably under that (3.5s apart
// gives ~17/min ceiling with room for other traffic on the same IP).
const RATE_LIMIT_DELAY_MS = 3500;

function apiKey(): string {
  const key = process.env.BASE_NOTIFICATIONS_API_KEY;
  if (!key) throw new Error("BASE_NOTIFICATIONS_API_KEY is not set");
  return key;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BaseNotificationParams = {
  title: string; // max 30 chars per spec — truncated defensively below
  message: string; // max 200 chars per spec — truncated defensively below
  targetPath?: string; // e.g. "/rewards" — must start with "/". Omit to open app root.
};

type BaseSendResult = {
  walletAddress: string;
  sent: boolean;
  failureReason?: string; // "user has not saved this app" | "user has notifications disabled"
};

type BaseSendResponse = {
  success: boolean;
  results: BaseSendResult[];
  sentCount: number;
  failedCount: number;
};

type BaseUsersResponse = {
  success: boolean;
  users: { address: string; notificationsEnabled: boolean }[];
  nextCursor?: string;
};

// Fetches every wallet address currently opted in to notifications for this
// app, paging through the full result set (capped at 500/page per Base).
export async function getOptedInWallets(appUrl: string): Promise<string[]> {
  const addresses: string[] = [];
  let cursor: string | undefined;
  let first = true;

  do {
    if (!first) await sleep(RATE_LIMIT_DELAY_MS);
    first = false;

    const params = new URLSearchParams({
      app_url: appUrl,
      notification_enabled: "true",
      limit: String(MAX_USERS_PAGE_SIZE),
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${BASE_API}/app/users?${params.toString()}`, {
      headers: { "x-api-key": apiKey() },
    });

    if (!res.ok) {
      throw new Error(`Base users fetch failed: ${res.status} ${await res.text()}`);
    }

    const json: BaseUsersResponse = await res.json();
    for (const u of json.users ?? []) {
      if (u.notificationsEnabled) addresses.push(u.address);
    }
    cursor = json.nextCursor;
  } while (cursor);

  return addresses;
}

// Checks a single wallet's pin/notification status — handy for rendering
// "enable notifications" CTAs in the UI. Not used by the send paths below.
export async function getWalletNotificationStatus(
  appUrl: string,
  walletAddress: string,
): Promise<{ appPinned: boolean; notificationsEnabled: boolean }> {
  const res = await fetch(`${BASE_API}/app/user/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
    body: JSON.stringify({ app_url: appUrl, wallet_address: walletAddress }),
  });

  if (!res.ok) {
    throw new Error(`Base user status failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Cached wrapper around getWalletNotificationStatus, for the client-facing
// status route below. This is what powers the in-app "are notifications on"
// check that used to only work for Farcaster (via sdk.context) — Base App
// never populates that context, so Base users need their own check.
//
// IMPORTANT: this gets called once per app open, per Base user — unlike
// server-triggered sends, this is client-triggered and its volume scales
// with your user count, not with how often you broadcast. Base's docs state
// the /users and /send endpoints share a 20 req/min per-IP limit; a status
// check on every page load would blow through that almost immediately once
// you have more than a couple dozen concurrent Base users. Caching each
// wallet's result for a few minutes keeps this endpoint's traffic near-zero
// against that budget regardless of how many people open the app.
const STATUS_CACHE_TTL_SECONDS = 300; // 5 minutes

function statusCacheKey(appUrl: string, walletAddress: string) {
  return `grub:base-status:${appUrl}:${walletAddress.toLowerCase()}`;
}

export async function getWalletNotificationStatusCached(
  appUrl: string,
  walletAddress: string,
): Promise<{ appPinned: boolean; notificationsEnabled: boolean }> {
  const key = statusCacheKey(appUrl, walletAddress);

  try {
    const cached = await kv.get<{ appPinned: boolean; notificationsEnabled: boolean }>(key);
    if (cached) return cached;
  } catch {
    // Cache miss/error — fall through to a live check rather than failing.
  }

  const fresh = await getWalletNotificationStatus(appUrl, walletAddress);
  try {
    await kv.set(key, fresh, { ex: STATUS_CACHE_TTL_SECONDS });
  } catch {
    // Non-fatal — worst case this wallet's next request re-hits the API.
  }
  return fresh;
}

async function sendBatch(
  appUrl: string,
  walletAddresses: string[],
  params: BaseNotificationParams,
): Promise<BaseSendResponse> {
  const res = await fetch(`${BASE_API}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
    body: JSON.stringify({
      app_url: appUrl,
      wallet_addresses: walletAddresses,
      title: params.title.slice(0, 30),
      message: params.message.slice(0, 200),
      ...(params.targetPath ? { target_path: params.targetPath } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Base notification send failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Send to one specific wallet address (the Base-side equivalent of
// sendNotificationToUser in lib/send-notification.ts).
export async function sendNotificationToWalletBase(
  appUrl: string,
  walletAddress: string,
  params: BaseNotificationParams,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const result = await sendBatch(appUrl, [walletAddress], params);
    const entry = result.results?.find(
      (r) => r.walletAddress.toLowerCase() === walletAddress.toLowerCase(),
    );
    if (!entry) return { sent: false, reason: "no_result" };
    return { sent: entry.sent, reason: entry.failureReason };
  } catch (err: any) {
    return { sent: false, reason: err?.message ?? "send_failed" };
  }
}

// Broadcast to every wallet currently opted in. Pages through the full
// audience, batches sends in chunks of 1000 (Base's max per request), and
// paces requests to stay under the shared 20 req/min rate limit.
export async function sendNotificationToAllBase(
  appUrl: string,
  params: BaseNotificationParams,
  excludeAddresses: string[] = [],
): Promise<{ totalSent: number; totalFailed: number }> {
  const excludeSet = new Set(excludeAddresses.map((a) => a.toLowerCase()));
  const all = await getOptedInWallets(appUrl);
  const targets = all.filter((a) => !excludeSet.has(a.toLowerCase()));

  let totalSent = 0;
  let totalFailed = 0;

  for (let i = 0; i < targets.length; i += MAX_ADDRESSES_PER_BATCH) {
    if (i > 0) await sleep(RATE_LIMIT_DELAY_MS);

    const chunk = targets.slice(i, i + MAX_ADDRESSES_PER_BATCH);
    try {
      const result = await sendBatch(appUrl, chunk, params);
      totalSent += result.sentCount ?? 0;
      totalFailed += result.failedCount ?? 0;
    } catch (err) {
      console.error("Base batch send failed:", err);
      totalFailed += chunk.length;
    }
  }

  return { totalSent, totalFailed };
}
