// app/api/debug-kv/route.ts
// GET /api/debug-kv
// Scans all grub pet keys and returns full user + referral state.
// Protected by Clerk — requires a valid session token in Authorization header.

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { verifyToken } from "@clerk/nextjs/server";

export async function GET(req: NextRequest) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // ── Basic connectivity check ──────────────────────────────────────────
    await kv.set("test:ping", "pong");
    const ping = await kv.get("test:ping");

    // ── Scan all grub pet keys ────────────────────────────────────────────
    const keys = await kv.keys("grub:pet:*");

    const users = await Promise.all(
      keys.map(async (key) => {
        const state = await kv.get<any>(key);
        const fid = key.replace("grub:pet:", "");

        if (!state) return { fid, key, error: "empty state" };

        const streakBug = state.streak !== state.checkinStreak;

        const unlockedAccessories: string[] = Array.isArray(state.accessories?.unlocked)
          ? state.accessories.unlocked
          : [];

        const referredUsers: number[] = await kv.get<number[]>(`referrer:${fid}:referred`) ?? [];
        const referredByFid = await kv.get<string>(`ref:${fid}`) ?? null;

        const referralDetails = await Promise.all(
          referredUsers.map(async (refFid) => {
            const checkins = await kv.get<number>(`ref:${refFid}:checkins`) ?? 0;
            const status = await kv.get<string>(`ref:${refFid}:status`) ?? "joined";
            return { fid: refFid, checkins, status };
          })
        );

        const degenEarned =
          referralDetails.filter((r) => r.status === "paid").length * 2 +
          referralDetails.length * 1;

        return {
          fid,
          streak: state.streak,
          checkinStreak: state.checkinStreak,
          streakBug,
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
          referrals: {
            referredBy: referredByFid ? Number(referredByFid) : null,
            referredCount: referredUsers.length,
            referredUsers: referralDetails,
            degenEarned,
          },
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
      streakFixNeeded: bugged.map((u) => ({
        fid: (u as any).fid,
        streak: (u as any).streak,
        checkinStreak: (u as any).checkinStreak,
      })),
      accessoryUnlockers: usersWithAccessories.map((u) => ({
        fid: (u as any).fid,
        accessoriesUnlockedCount: (u as any).accessoriesUnlockedCount,
        accessoriesUnlocked: (u as any).accessoriesUnlocked,
      })),
      referralSummary: users
        .filter((u) => ((u as any).referrals?.referredCount ?? 0) > 0)
        .map((u) => ({
          fid: (u as any).fid,
          referredCount: (u as any).referrals.referredCount,
          referredUsers: (u as any).referrals.referredUsers,
          degenEarned: (u as any).referrals.degenEarned,
        })),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message });
  }
}
