import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export async function GET(req: NextRequest) {
  const fid = req.nextUrl.searchParams.get("fid");
  if (!fid) {
    return NextResponse.json({ error: "missing fid" }, { status: 400 });
  }

  try {
    const state = await kv.get(`grub:pet:${fid}`);
    return NextResponse.json(state ?? null);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, state } = body;

    if (!fid || !state) {
      return NextResponse.json({ error: "missing fid or state" }, { status: 400 });
    }

    await kv.set(`grub:pet:${fid}`, state);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
