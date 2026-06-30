// app/api/admin/notif-diff/route.ts
// GET /api/admin/notif-diff?secret=xxx
//
// Diffs the notification-token FID set against the grub:pet:* key set
// so you can see exactly who has enabled notifications but never got
// a pet saved (and vice versa).

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getAllFidsForApp } from "@/lib/notification-tokens";

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const APP_FID = 9152;

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // FIDs with a saved notification token
    const notifFids = await getAllFidsForApp(APP_FID);

    // FIDs with a saved pet state
    const petKeys = await kv.keys("grub:pet:*");
    const petFids = petKeys.map((k) => Number(k.replace("grub:pet:", "")));

    const notifSet = new Set(notifFids);
    const petSet = new Set(petFids);

    const notifButNoPet = notifFids.filter((fid) => !petSet.has(fid));
    const petButNoNotif = petFids.filter((fid) => !notifSet.has(fid));
    const both = notifFids.filter((fid) => petSet.has(fid));

    return NextResponse.json({
      summary: {
        totalNotifFids: notifFids.length,
        totalPetFids: petFids.length,
        bothCount: both.length,
        notifButNoPetCount: notifButNoPet.length,
        petButNoNotifCount: petButNoNotif.length,
      },
      notifButNoPet,   // <- the "added app, no pet save" list you're after
      petButNoNotif,
      both,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
