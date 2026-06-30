// app/api/debug-backfill-added/route.ts
// GET /api/debug-backfill-added
//
// ONE-TIME FIX for the notifications_enabled bug: any fid that has a
// notif token but was never marked as "added" (because the old webhook
// code didn't call markAppAdded in that case) gets backfilled here.
//
// Safe to run multiple times — markAppAdded is just an sadd, so already-
// added fids are untouched.
//
// Protected by Clerk, same as debug-kv.

import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/nextjs/server";
import { getAllFidsForApp, getAllAddedFids, markAppAdded } from "@/lib/notification-tokens";

const APP_FID = 9152;

export async function GET(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const notifFids = await getAllFidsForApp(APP_FID);
    const addedFidsBefore = new Set(await getAllAddedFids(APP_FID));

    const missing = notifFids.filter((fid) => !addedFidsBefore.has(fid));

    await Promise.all(missing.map((fid) => markAppAdded(fid, APP_FID)));

    return NextResponse.json({
      success: true,
      notifFidsCount: notifFids.length,
      alreadyAddedCount: addedFidsBefore.size,
      backfilledCount: missing.length,
      backfilledFids: missing,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 });
  }
}
