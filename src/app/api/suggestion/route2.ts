// app/api/suggestion/route.ts
//
// POST /api/suggestion
//   Body: { fid?: number|string, wallet?: string, type: "suggestion" | "issue", text: string }
//   Public endpoint — called directly from the app, no auth required (same
//   trust model as /api/txn-log's POST). Identity follows the same fid/wallet
//   convention used everywhere else in the app (see Client.tsx's saveIdentity
//   pattern: `fid ? { fid } : walletAddress ? { wallet } : null`).
//
//   Rate-limited per identity, tracked in KV:
//     - "issue"      → max 1 per rolling hour
//     - "suggestion" → max 2 per UTC calendar day
//
// GET is intentionally NOT exposed here — admin reads happen through
// /api/admin/suggestions instead, which is Clerk-protected. This route only
// ever writes on behalf of whoever is currently using the app.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

const LIST_KEY = "suggestions:list";
const MAX_LIST_LENGTH = 1000; // same cap pattern as txn-log's global list
const MAX_TEXT_LENGTH = 500;
const MIN_TEXT_LENGTH = 3;

const ISSUE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const SUGGESTION_WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h, not calendar-day
const SUGGESTION_GAP_MS = 12 * 60 * 60 * 1000;     // min gap between the two allowed
const SUGGESTION_WINDOW_LIMIT = 2;

export type SuggestionType = "suggestion" | "issue";

export type SuggestionEntry = {
  id: string;
  fid: number | string | null; // null when the submitter is wallet-only
  wallet: string | null;
  identity: string;             // display label, e.g. "fid:203912" or "wallet:0xabc…"
  type: SuggestionType;
  text: string;
  status: "new" | "seen" | "resolved" | "archived";
  ts: number;
};

// Normalizes fid/wallet into one identity key + display label. Kept local
// (rather than importing lib/pet-key.ts's petKey/identityLabel) since this
// route doesn't touch pet state and doesn't need that module's grub:pet:*
// key format — just something stable to rate-limit and display by.
function resolveIdentity(
  fid: unknown,
  wallet: unknown,
): { key: string; label: string; fidOut: number | string | null; walletOut: string | null } | null {
  if (fid !== undefined && fid !== null && String(fid).trim() !== "") {
    const fidStr = String(fid).trim();
    return { key: `fid:${fidStr}`, label: `fid:${fidStr}`, fidOut: fidStr, walletOut: null };
  }
  if (typeof wallet === "string" && wallet.trim() !== "") {
    const w = wallet.trim().toLowerCase();
    return { key: `wallet:${w}`, label: `wallet:${w}`, fidOut: null, walletOut: w };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, wallet, type, text } = body ?? {};

    if (type !== "suggestion" && type !== "issue") {
      return NextResponse.json({ ok: false, error: `type must be "suggestion" or "issue"` }, { status: 400 });
    }

    const identity = resolveIdentity(fid, wallet);
    if (!identity) {
      return NextResponse.json({ ok: false, error: "Missing fid or wallet identity." }, { status: 400 });
    }

    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length < MIN_TEXT_LENGTH) {
      return NextResponse.json({ ok: false, error: "Please add a bit more detail." }, { status: 400 });
    }
    if (trimmed.length > MAX_TEXT_LENGTH) {
      return NextResponse.json({ ok: false, error: `Keep it under ${MAX_TEXT_LENGTH} characters.` }, { status: 400 });
    }

    // ── Rate limiting ──────────────────────────────────────────────────────
    if (type === "issue") {
      const cooldownKey = `suggestion:cooldown:issue:${identity.key}`;
      const lastTs = await kv.get<number>(cooldownKey);
      if (lastTs && Date.now() - lastTs < ISSUE_COOLDOWN_MS) {
        return NextResponse.json(
          {
            ok: false,
            error: "You can report another issue in a little while.",
            retryAt: lastTs + ISSUE_COOLDOWN_MS,
          },
          { status: 429 },
        );
      }
      await kv.set(cooldownKey, Date.now(), { ex: Math.ceil(ISSUE_COOLDOWN_MS / 1000) + 5 });
    } else {
      // "suggestion" — up to 2 per ROLLING 24h (not a UTC calendar-day reset,
      // which produced a confusing "wait 19h" instead of a clean 24h — the
      // reset point used to be midnight UTC regardless of when in the day
      // the user actually submitted, so the remaining wait depended on the
      // clock rather than on their own last submission). Also enforces a
      // minimum 12h gap between the two, so they can't be sent back-to-back.
      //
      // Stored as a small array of this identity's own submission timestamps
      // (max 2 kept), pruned to only ones still inside the 24h window before
      // every check — so the window always tracks THEIR last submission(s),
      // not a fixed clock boundary.
      const timesKey = `suggestion:times:${identity.key}`;
      const now = Date.now();
      let times = ((await kv.get<number[]>(timesKey)) ?? []).filter((t) => now - t < SUGGESTION_WINDOW_MS);

      if (times.length >= SUGGESTION_WINDOW_LIMIT) {
        const oldest = Math.min(...times);
        return NextResponse.json(
          {
            ok: false,
            error: "You've reached the suggestion limit for now — try again later.",
            retryAt: oldest + SUGGESTION_WINDOW_MS,
          },
          { status: 429 },
        );
      }
      if (times.length === 1 && now - times[0] < SUGGESTION_GAP_MS) {
        return NextResponse.json(
          {
            ok: false,
            error: "Please wait a bit before sending another suggestion.",
            retryAt: times[0] + SUGGESTION_GAP_MS,
          },
          { status: 429 },
        );
      }

      times.push(now);
      await kv.set(timesKey, times, { ex: Math.ceil(SUGGESTION_WINDOW_MS / 1000) + 60 });
    }

    // ── Save entry ─────────────────────────────────────────────────────────
    const entry: SuggestionEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      fid: identity.fidOut,
      wallet: identity.walletOut,
      identity: identity.label,
      type,
      text: trimmed,
      status: "new",
      ts: Date.now(),
    };

    const list = (await kv.get<SuggestionEntry[]>(LIST_KEY)) ?? [];
    list.push(entry);
    if (list.length > MAX_LIST_LENGTH) list.splice(0, list.length - MAX_LIST_LENGTH);
    await kv.set(LIST_KEY, list);

    return NextResponse.json({ ok: true, id: entry.id });
  } catch (err: any) {
    console.error("[suggestion] error:", err);
    return NextResponse.json({ ok: false, error: err?.message ?? "unknown error" }, { status: 500 });
  }
}
