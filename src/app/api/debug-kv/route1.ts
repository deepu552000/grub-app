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
        };
      })
    );

    const bugged = users.filter((u) => (u as any).streakBug);

    return NextResponse.json({
      ping,
      totalUsers: keys.length,
      buggedStreakCount: bugged.length,
      users,
      // Easy copy-paste: lists only FIDs that need streak fixing
      streakFixNeeded: bugged.map((u) => ({
        fid: (u as any).fid,
        streak: (u as any).streak,
        checkinStreak: (u as any).checkinStreak,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message });
  }
}
