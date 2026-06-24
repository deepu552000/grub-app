import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export async function GET() {
  try {
    await kv.set("test:ping", "pong");
    const val = await kv.get("test:ping");
    return NextResponse.json({ success: true, val });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message });
  }
}
