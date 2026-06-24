import { NextResponse } from "next/server";
import { getAllFidsForApp } from "@/lib/notification-tokens";

const APP_FID = 9152;

export async function GET() {
  const fids = await getAllFidsForApp(APP_FID);
  return NextResponse.json({ 
    totalUsers: fids.length,
    fids 
  });
}
