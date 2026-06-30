// app/api/admin/resolve-fids/route.ts
// Resolves a list of Farcaster FIDs to usernames/display names via Neynar.
// Protected by Clerk — requires a valid session token in Authorization header
// (same pattern as /api/debug-kv).

import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/nextjs/server";

const NEYNAR_BASE = "https://api.neynar.com/v2/farcaster/user/bulk";
const CHUNK_SIZE = 100; // Neynar's bulk endpoint accepts up to 100 fids per call

export async function POST(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const apiKey = process.env.NEYNAR_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "NEYNAR_API_KEY not configured" }, { status: 500 });
    }

    const body = await req.json();
    const fids: (string | number)[] = Array.isArray(body?.fids) ? body.fids : [];

    const cleanFids = Array.from(
      new Set(
        fids
          .map((f) => Number(f))
          .filter((f) => Number.isFinite(f) && f > 0)
      )
    );

    if (cleanFids.length === 0) {
      return NextResponse.json({ users: [] });
    }

    // Split into chunks of 100 (Neynar's bulk limit)
    const chunks: number[][] = [];
    for (let i = 0; i < cleanFids.length; i += CHUNK_SIZE) {
      chunks.push(cleanFids.slice(i, i + CHUNK_SIZE));
    }

    const results: {
      fid: number;
      username: string | null;
      displayName: string | null;
      pfpUrl: string | null;
    }[] = [];

    for (const chunk of chunks) {
      const url = `${NEYNAR_BASE}?fids=${chunk.join(",")}`;
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
        },
        // Cache for a bit since usernames rarely change
        next: { revalidate: 300 },
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("Neynar bulk lookup failed:", res.status, errText);
        continue; // skip this chunk, don't fail the whole request
      }

      const data = await res.json();
      const usersArr = Array.isArray(data?.users) ? data.users : [];

      for (const u of usersArr) {
        results.push({
          fid: u.fid,
          username: u.username ?? null,
          displayName: u.display_name ?? null,
          pfpUrl: u.pfp_url ?? null,
        });
      }
    }

    return NextResponse.json({ users: results });
  } catch (err: any) {
    console.error("resolve-fids error:", err);
    return NextResponse.json({ error: "Failed to resolve fids" }, { status: 500 });
  }
}
