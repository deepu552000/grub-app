// lib/send-notification.ts
//
// Core helper for actually pushing a notification to one or many users.
// Batches up to 100 tokens per request per the Farcaster spec.

import { getAllNotificationDetailsForApp, type NotificationDetails } from "./notification-tokens";

const MAX_TOKENS_PER_BATCH = 100;

export type SendNotificationParams = {
  notificationId: string; // dedupe key on the client side — reuse the same id across batches of the same logical notification
  title: string; // max 32 chars per spec
  body: string; // max 128 chars per spec
  targetUrl: string; // deep link back into your app, must match your manifest domain
};

type SendResult = {
  successfulTokens: string[];
  invalidTokens: string[]; // app should stop trying these (user disabled/removed)
  rateLimitedTokens: string[]; // safe to retry later
};

// Sends to a specific list of {url, token} pairs (all tokens in a batch must
// share the same url, since url is which host's notification server to hit —
// in practice this is almost always the same Farcaster relay URL).
async function sendBatch(
  url: string,
  tokens: string[],
  params: SendNotificationParams,
): Promise<SendResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      notificationId: params.notificationId,
      title: params.title,
      body: params.body,
      targetUrl: params.targetUrl,
      tokens,
    }),
  });

  if (!res.ok) {
    throw new Error(`Notification send failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return {
    successfulTokens: json.successfulTokens ?? [],
    invalidTokens: json.invalidTokens ?? [],
    rateLimitedTokens: json.rateLimitedTokens ?? [],
  };
}

// Send to one specific user (fid). Looks up their stored token first.
export async function sendNotificationToUser(
  fid: number,
  appFid: number,
  params: SendNotificationParams,
): Promise<{ sent: boolean; reason?: string }> {
  const { getNotificationDetails, removeNotificationDetails } = await import(
    "./notification-tokens"
  );
  const details = await getNotificationDetails(fid, appFid);
  if (!details) return { sent: false, reason: "no_token" };

  try {
    const result = await sendBatch(details.url, [details.token], params);
    if (result.invalidTokens.includes(details.token)) {
      // Token is dead — user disabled notifications or removed the app.
      // Clean it up so we stop trying.
      await removeNotificationDetails(fid, appFid);
      return { sent: false, reason: "invalid_token" };
    }
    return { sent: result.successfulTokens.includes(details.token) };
  } catch (err: any) {
    return { sent: false, reason: err?.message ?? "send_failed" };
  }
}

// Broadcast to everyone who has notifications enabled for this app.
// Used by the check-in reminder cron. Groups tokens by url and batches
// in chunks of 100 per the spec.
export async function sendNotificationToAll(
  appFid: number,
  params: SendNotificationParams,
): Promise<{ totalSent: number; totalInvalid: number; totalFailed: number }> {
  const all = await getAllNotificationDetailsForApp(appFid);

  // Group by url (the relay endpoint) since a batch request goes to one url.
  const byUrl = new Map<string, { fid: number; token: string }[]>();
  for (const { fid, details } of all) {
    const list = byUrl.get(details.url) ?? [];
    list.push({ fid, token: details.token });
    byUrl.set(details.url, list);
  }

  let totalSent = 0;
  let totalInvalid = 0;
  let totalFailed = 0;

  for (const [url, entries] of byUrl) {
    for (let i = 0; i < entries.length; i += MAX_TOKENS_PER_BATCH) {
      const chunk = entries.slice(i, i + MAX_TOKENS_PER_BATCH);
      const tokens = chunk.map((e) => e.token);

      try {
        const result = await sendBatch(url, tokens, params);
        totalSent += result.successfulTokens.length;
        totalInvalid += result.invalidTokens.length;

        // Clean up dead tokens so future sends don't keep hitting them.
        if (result.invalidTokens.length > 0) {
          const { removeNotificationDetails } = await import("./notification-tokens");
          const invalidFids = chunk
            .filter((e) => result.invalidTokens.includes(e.token))
            .map((e) => e.fid);
          await Promise.all(invalidFids.map((fid) => removeNotificationDetails(fid, appFid)));
        }
      } catch (err) {
        console.error("Batch send failed:", err);
        totalFailed += chunk.length;
      }
    }
  }

  return { totalSent, totalInvalid, totalFailed };
}
