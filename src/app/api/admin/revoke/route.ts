// src/app/api/admin/revoke/route.ts
// ONE-TIME USE admin route — delete or disable after use!
// Call: POST /api/admin/revoke  { "fid": 18561, "secret": "your-secret", "accessories": ["party-hat-pink"] }

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";

export async function POST(req: NextRequest) {
  const { fid, secret, accessories } = await req.json();

  if (!secret || secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!fid) {
    return NextResponse.json({ error: "missing fid" }, { status: 400 });
  }

  const state = await kv.get<any>(`grub:pet:${fid}`);
  if (!state) {
    return NextResponse.json({ error: "No state found for this fid" }, { status: 404 });
  }

  const before = state?.accessories?.unlocked ?? [];

  // Remove specified accessories, or clear ALL if none specified
  const toRevoke: string[] = accessories ?? before;
  const after = before.filter((id: string) => !toRevoke.includes(id));

  const newState = {
    ...state,
    accessories: {
      ...state.accessories,
      unlocked: after,
      equipped: (state.accessories?.equipped ?? []).filter((id: string) => !toRevoke.includes(id)),
    },
  };

  await kv.set(`grub:pet:${fid}`, newState);

  console.log(`[admin/revoke] fid=${fid} removed=${JSON.stringify(toRevoke)} remaining=${JSON.stringify(after)}`);

  return NextResponse.json({
    ok: true,
    fid,
    revoked: toRevoke,
    remainingUnlocked: after,
  });
}
