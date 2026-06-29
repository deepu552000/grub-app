// app/api/admin/user-control/route.ts
//
// Per-user admin controls for Grub. Two endpoints in one file:
//
//   GET  /api/admin/user-control?fid=<fid>&secret=<ADMIN_SECRET>
//        Returns the current pet state + referral info for that fid.
//
//   POST /api/admin/user-control
//        Body: { secret, fid, action, ...actionParams }
//        action = "revoke_accessory" | "unlock_accessory" | "adjust_stats"
//               | "ban" | "unban" | "edit_referral"
//
// NOTE on "ban": this sets a `banned: true/false` flag on the user's
// grub:pet:<fid> record. /api/pet checks this flag on every POST and
// rejects writes (403) for banned fids — feeding, unlocking, checking in,
// all blocked. A banned player can still load the app and see their pet,
// but can't take any action that writes state.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ACCESSORIES } from "@/lib/accessories";

const VALID_ACCESSORY_IDS = new Set(ACCESSORIES.map((a) => a.id));

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";

function unauthorized() {
  return NextResponse.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
}

async function getPetState(fid: string) {
  return await kv.get<any>(`grub:pet:${fid}`);
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== ADMIN_SECRET) return unauthorized();

  const fid = req.nextUrl.searchParams.get("fid");
  if (!fid) {
    return NextResponse.json({ ok: false, reason: "missing fid" }, { status: 400 });
  }

  const state = await getPetState(fid);
  if (!state) {
    return NextResponse.json({ ok: false, reason: `no pet state found for fid ${fid}` });
  }

  const referredByFid = await kv.get<string>(`ref:${fid}`);
  const referredUsers = (await kv.get<number[]>(`referrer:${fid}:referred`)) ?? [];

  return NextResponse.json({
    ok: true,
    fid,
    state: {
      xp: Math.floor(state.xp ?? 0),
      bond: state.bond ?? 0,
      glimmer: state.glimmer ?? 0,
      hunger: state.hunger ?? 0,
      happiness: state.happiness ?? 0,
      totalCheckIns: state.totalCheckIns ?? 0,
      banned: state.banned ?? false,
      accessoriesUnlocked: state.accessories?.unlocked ?? [],
      accessoriesEquipped: state.accessories?.equipped ?? {},
    },
    referral: {
      referredByFid: referredByFid ?? null,
      referredUsers,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { secret, fid, action } = body;

    if (!secret || secret !== ADMIN_SECRET) return unauthorized();

    if (!fid || !action) {
      return NextResponse.json({ ok: false, reason: "missing fid or action" }, { status: 400 });
    }

    // ── Revoke a specific accessory ─────────────────────────────────────
    if (action === "revoke_accessory") {
      const { accessoryId } = body;
      if (!accessoryId) {
        return NextResponse.json({ ok: false, reason: "missing accessoryId" }, { status: 400 });
      }

      if (!VALID_ACCESSORY_IDS.has(accessoryId)) {
        return NextResponse.json({
          ok: false,
          reason: `unknown accessory "${accessoryId}". Valid IDs: ${[...VALID_ACCESSORY_IDS].join(", ")}`,
        }, { status: 400 });
      }

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const accessories = state.accessories ?? { unlocked: [], equipped: {} };
      if (!(accessories.unlocked ?? []).includes(accessoryId)) {
        return NextResponse.json({ ok: false, reason: `accessory "${accessoryId}" was not unlocked` });
      }

      const newUnlocked = accessories.unlocked.filter((id: string) => id !== accessoryId);
      const newEquipped = { ...accessories.equipped };
      for (const slot of Object.keys(newEquipped)) {
        if (newEquipped[slot] === accessoryId) delete newEquipped[slot];
      }

      await kv.set(`grub:pet:${fid}`, {
        ...state,
        accessories: { unlocked: newUnlocked, equipped: newEquipped },
      });

      return NextResponse.json({ ok: true, fid, action, revoked: accessoryId, remainingUnlocked: newUnlocked });
    }

    // ── Unlock a specific accessory (admin grant) ───────────────────────
    if (action === "unlock_accessory") {
      const { accessoryId } = body;
      if (!accessoryId) {
        return NextResponse.json({ ok: false, reason: "missing accessoryId" }, { status: 400 });
      }

      if (!VALID_ACCESSORY_IDS.has(accessoryId)) {
        return NextResponse.json({
          ok: false,
          reason: `unknown accessory "${accessoryId}". Valid IDs: ${[...VALID_ACCESSORY_IDS].join(", ")}`,
        }, { status: 400 });
      }

      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const accessories = state.accessories ?? { unlocked: [], equipped: {} };
      const alreadyUnlocked: string[] = accessories.unlocked ?? [];

      if (alreadyUnlocked.includes(accessoryId)) {
        return NextResponse.json({ ok: false, reason: `accessory "${accessoryId}" is already unlocked` });
      }

      const newUnlocked = [...alreadyUnlocked, accessoryId];
      await kv.set(`grub:pet:${fid}`, {
        ...state,
        accessories: { ...accessories, unlocked: newUnlocked },
      });

      return NextResponse.json({ ok: true, fid, action, unlocked: accessoryId, allUnlocked: newUnlocked });
    }

    // ── Adjust stats directly ───────────────────────────────────────────
    if (action === "adjust_stats") {
      const { xp, bond, glimmer, hunger, happiness } = body;
      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      const updated = {
        ...state,
        xp: typeof xp === "number" ? xp : state.xp,
        bond: typeof bond === "number" ? bond : state.bond,
        glimmer: typeof glimmer === "number" ? glimmer : state.glimmer,
        hunger: typeof hunger === "number" ? hunger : state.hunger,
        happiness: typeof happiness === "number" ? happiness : state.happiness,
      };

      await kv.set(`grub:pet:${fid}`, updated);

      return NextResponse.json({
        ok: true,
        fid,
        action,
        newStats: { xp: updated.xp, bond: updated.bond, glimmer: updated.glimmer, hunger: updated.hunger, happiness: updated.happiness },
      });
    }

    // ── Ban / unban ─────────────────────────────────────────────────────
    if (action === "ban" || action === "unban") {
      const state = await getPetState(fid);
      if (!state) return NextResponse.json({ ok: false, reason: `no pet state for fid ${fid}` });

      await kv.set(`grub:pet:${fid}`, { ...state, banned: action === "ban" });

      return NextResponse.json({ ok: true, fid, action, banned: action === "ban" });
    }

    // ── Edit / remove referral relationship ─────────────────────────────
    if (action === "edit_referral") {
      const { newReferrerFid, removeReferral } = body;

      if (removeReferral) {
        await kv.del(`ref:${fid}`);
        await kv.del(`ref:${fid}:checkins`);
        await kv.del(`ref:${fid}:status`);
        return NextResponse.json({ ok: true, fid, action, removed: true });
      }

      if (newReferrerFid) {
        await kv.set(`ref:${fid}`, String(newReferrerFid));
        const referred = (await kv.get<number[]>(`referrer:${newReferrerFid}:referred`)) ?? [];
        if (!referred.includes(Number(fid))) {
          await kv.set(`referrer:${newReferrerFid}:referred`, [...referred, Number(fid)]);
        }
        return NextResponse.json({ ok: true, fid, action, newReferrerFid });
      }

      return NextResponse.json({ ok: false, reason: "provide newReferrerFid or removeReferral:true" }, { status: 400 });
    }

    return NextResponse.json({ ok: false, reason: `unknown action "${action}"` }, { status: 400 });
  } catch (err: any) {
    console.error("[admin/user-control] error:", err);
    return NextResponse.json({ ok: false, reason: err?.message ?? "unknown error" }, { status: 500 });
  }
}
