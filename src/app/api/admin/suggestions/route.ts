// app/api/admin/suggestions/route.ts
//
// GET  /api/admin/suggestions
//        Lists every submitted suggestion/issue, newest first.
//
// POST /api/admin/suggestions
//        Body: { id, status: "seen" | "resolved" | "archived" }
//        Updates a single entry's status. "archived" hides it from the
//        dashboard's default ("active") view without deleting it.
//
// Clerk-protected — same auth pattern as /api/admin/failed-payouts and
// /api/debug-kv (Bearer token in Authorization header, verified server-side).

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";

// Mirrors the type in app/api/suggestion/route.ts. Not imported directly —
// keeping a plain local type here avoids any bundling coupling between the
// two routes; they only need to agree on the KV shape, not share a module.
type SuggestionEntry = {
  id: string;
  fid: number | string | null;
  wallet: string | null;
  identity: string;
  type: "suggestion" | "issue";
  text: string;
  status: "new" | "seen" | "resolved" | "archived";
  ts: number;
};

const LIST_KEY = "suggestions:list";

async function requireAuth(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const list = (await kv.get<SuggestionEntry[]>(LIST_KEY)) ?? [];
    return NextResponse.json({ ok: true, count: list.length, suggestions: list.slice().reverse() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { id, status } = await req.json();
    if (!id || !status) {
      return NextResponse.json({ ok: false, reason: "missing id or status" }, { status: 400 });
    }
    if (!["new", "seen", "resolved", "archived"].includes(status)) {
      return NextResponse.json({ ok: false, reason: `invalid status "${status}"` }, { status: 400 });
    }

    const list = (await kv.get<SuggestionEntry[]>(LIST_KEY)) ?? [];
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) {
      return NextResponse.json({ ok: false, reason: "suggestion not found" }, { status: 404 });
    }
    list[idx] = { ...list[idx], status };
    await kv.set(LIST_KEY, list);

    return NextResponse.json({ ok: true, id, status });
  } catch (err: any) {
    console.error("[admin/suggestions] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
