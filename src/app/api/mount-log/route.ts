import { NextRequest, NextResponse } from "next/server";

// Works with either the Vercel KV integration (KV_REST_API_*) or a raw
// Upstash Redis instance (UPSTASH_REDIS_REST_*) — whichever env vars are
// already set for the rest of the app.
const KV_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LIST_KEY = "mount-log";
const MAX_ENTRIES = 300;

async function kv(command: (string | number)[]) {
  if (!KV_URL || !KV_TOKEN) return null;
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) return null;
  return res.json();
}

// POST — record one checkpoint from a client mount/load sequence.
// Body: { session: string, stage: string, extra?: object }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const entry = {
      t: Date.now(),
      session: String(body.session || "unknown").slice(0, 64),
      stage: String(body.stage || "unknown").slice(0, 64),
      ua: req.headers.get("user-agent")?.slice(0, 200) || "",
      extra: body.extra ?? null,
    };
    // LPUSH then trim to keep the list bounded
    await kv(["LPUSH", LIST_KEY, JSON.stringify(entry)]);
    await kv(["LTRIM", LIST_KEY, 0, MAX_ENTRIES - 1]);
    return NextResponse.json({ ok: true });
  } catch {
    // Never let logging failures surface to the client — this must be
    // fire-and-forget and silent no matter what.
    return NextResponse.json({ ok: false });
  }
}

// GET — view recent checkpoints, most recent first.
// Optional ?session=xxx to filter to one load session.
export async function GET(req: NextRequest) {
  const sessionFilter = req.nextUrl.searchParams.get("session");
  const raw = await kv(["LRANGE", LIST_KEY, 0, MAX_ENTRIES - 1]);
  const rows: string[] = raw?.result ?? [];
  let entries = rows
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (sessionFilter) {
    entries = entries.filter((e) => e.session === sessionFilter);
  }

  return NextResponse.json({ count: entries.length, entries });
}
