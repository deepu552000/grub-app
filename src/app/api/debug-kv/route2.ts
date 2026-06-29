import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export async function GET() {
  try {
    // ── Basic connectivity check ──────────────────────────────────────────
    await kv.set("test:ping", "pong");
    const ping = await kv.get("test:ping");

    // ── Scan all grub pet keys ────────────────────────────────────────────
    // kv.keys() returns all keys matching the pattern
    const keys = await kv.keys("grub:pet:*");

    const users = await Promise.all(
      keys.map(async (key) => {
        const state = await kv.get<any>(key);
        const fid = key.replace("grub:pet:", "");

        if (!state) return { fid, key, error: "empty state" };

        const streakBug = state.streak !== state.checkinStreak;

        // Accessories: state.accessories.unlocked is expected to be an array
        // of unlocked accessory IDs (per your AccessoryState shape in
        // lib/pet-accessories-state.ts). Adjust the field name below if your
        // actual shape differs (e.g. a Set serialized as array, or per-slot map).
        const unlockedAccessories: string[] = Array.isArray(state.accessories?.unlocked)
          ? state.accessories.unlocked
          : [];

        return {
          fid,
          streak: state.streak,
          checkinStreak: state.checkinStreak,
          streakBug,                          // true = needs fixing
          totalCheckIns: state.totalCheckIns ?? 0,
          xp: Math.floor(state.xp ?? 0),
          bond: state.bond ?? 0,
          glimmer: state.glimmer ?? 0,
          hunger: state.hunger ?? 0,
          happiness: state.happiness ?? 0,
          lastCheckInDay: state.lastCheckInDay ?? "never",
          lastVisit: state.lastVisit
            ? new Date(state.lastVisit).toISOString()
            : "unknown",
          actionsToday: state.actionsToday ?? {},
          accessoriesUnlockedCount: unlockedAccessories.length,
          accessoriesUnlocked: unlockedAccessories,
        };
      })
    );

    const bugged = users.filter((u) => (u as any).streakBug);
    const usersWithAccessories = users.filter(
      (u) => ((u as any).accessoriesUnlockedCount ?? 0) > 0
    );

    return NextResponse.json({
      ping,
      totalUsers: keys.length,
      buggedStreakCount: bugged.length,
      usersWithAccessoriesCount: usersWithAccessories.length,
      users,
      // Easy copy-paste: lists only FIDs that need streak fixing
      streakFixNeeded: bugged.map((u) => ({
        fid: (u as any).fid,
        streak: (u as any).streak,
        checkinStreak: (u as any).checkinStreak,
      })),
      // Easy copy-paste: lists only FIDs that have unlocked at least one accessory
      accessoryUnlockers: usersWithAccessories.map((u) => ({
        fid: (u as any).fid,
        accessoriesUnlockedCount: (u as any).accessoriesUnlockedCount,
        accessoriesUnlocked: (u as any).accessoriesUnlocked,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message });
  }
}
