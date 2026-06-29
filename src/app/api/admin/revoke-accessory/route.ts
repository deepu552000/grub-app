// app/api/admin/revoke-accessory/route.ts
//
// ONE-OFF ADMIN TOOL — not meant to stay live permanently.
// Removes a specific accessory ID from a specific FID's unlocked list,
// and unequips it first if it was equipped. Use once, then delete this
// file (or at minimum comment out the body) so it isn't sitting around
// as an open, unauthenticated way to mutate any user's state.
//
// Usage (PowerShell), after deploying:
//   Invoke-RestMethod -Uri "https://grub-app-eight.vercel.app/api/admin/revoke-accessory?fid=18561&accessoryId=party-hat-pink" -Method POST

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fid = searchParams.get("fid");
    const accessoryId = searchParams.get("accessoryId");

    if (!fid || !accessoryId) {
      return NextResponse.json(
        { ok: false, reason: "Missing fid or accessoryId query param" },
        { status: 400 }
      );
    }

    const key = `grub:pet:${fid}`;
    const state = await kv.get<any>(key);

    if (!state) {
      return NextResponse.json({ ok: false, reason: `No pet state found for fid ${fid}` });
    }

    const accessories = state.accessories ?? { unlocked: [], equipped: {} };
    const wasUnlocked = (accessories.unlocked ?? []).includes(accessoryId);

    if (!wasUnlocked) {
      return NextResponse.json({
        ok: false,
        reason: `Accessory "${accessoryId}" was not unlocked for fid ${fid} — nothing to revoke`,
      });
    }

    // Remove from unlocked list
    const newUnlocked = accessories.unlocked.filter((id: string) => id !== accessoryId);

    // If it was equipped in any slot, unequip it too — otherwise the cat
    // could keep wearing an accessory the player no longer "owns".
    const newEquipped = { ...accessories.equipped };
    for (const slot of Object.keys(newEquipped)) {
      if (newEquipped[slot] === accessoryId) {
        delete newEquipped[slot];
      }
    }

    const newState = {
      ...state,
      accessories: { unlocked: newUnlocked, equipped: newEquipped },
    };

    await kv.set(key, newState);

    return NextResponse.json({
      ok: true,
      fid,
      revoked: accessoryId,
      remainingUnlocked: newUnlocked,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
