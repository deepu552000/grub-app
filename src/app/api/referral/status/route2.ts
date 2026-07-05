// app/api/referral/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getUsernamesFromNeynar, getBasenamesForWallets } from "@/lib/referral";

export async function GET(req: NextRequest) {
  try {
    const fid = req.nextUrl.searchParams.get("fid");
    const wallet = req.nextUrl.searchParams.get("wallet");

    // Base App (wallet-based) — new, completely separate from the fid path
    // below: different KV key prefixes (referrerbase:/refbase:) and
    // Basename resolution instead of Neynar.
    if (wallet) {
      const w = wallet.toLowerCase();
      const referred = (await kv.get<string[]>(`referrerbase:${w}:referred`)) ?? [];

      const friendStats = await Promise.all(
        referred.map(async (friendWallet) => {
          const checkins = (await kv.get<number>(`refbase:${friendWallet}:checkins`)) ?? 0;
          const status = (await kv.get<string>(`refbase:${friendWallet}:status`)) ?? "joined";
          return { wallet: friendWallet, checkins, status };
        }),
      );

      const nameMap = await getBasenamesForWallets(referred);

      const friends = friendStats.map((f) => ({
        ...f,
        username: nameMap[f.wallet] ?? f.wallet,
      }));

      const totalEarned =
        friends.filter((f) => f.status === "paid").length * 2 + friends.length * 1;

      return NextResponse.json({
        ok: true,
        referralLink: `https://grub-app-eight.vercel.app/?ref=${w}`,
        friends,
        totalEarned,
      });
    }

    if (!fid) {
      return NextResponse.json({ ok: false, reason: "missing fid or wallet" }, { status: 400 });
    }

    const referred = await kv.get<number[]>(`referrer:${fid}:referred`) ?? [];

    // Fetch checkin/status for each referred user
    const friendStats = await Promise.all(
      referred.map(async (friendFID) => {
        const checkins = await kv.get<number>(`ref:${friendFID}:checkins`) ?? 0;
        const status = await kv.get<string>(`ref:${friendFID}:status`) ?? "joined";
        return { fid: friendFID, checkins, status };
      })
    );

    // Bulk fetch usernames from Neynar in one call
    const usernameMap = await getUsernamesFromNeynar(referred);

    const friends = friendStats.map((f) => ({
      ...f,
      username: usernameMap[f.fid]?.username ?? `fid:${f.fid}`,
      pfp: usernameMap[f.fid]?.pfp ?? "",
    }));

    const totalEarned =
      friends.filter((f) => f.status === "paid").length * 2 +
      friends.length * 1;

    return NextResponse.json({
      ok: true,
      referralLink: `https://grub-app-eight.vercel.app/?ref=${fid}`,
      friends,
      totalEarned,
    });
  } catch (err: any) {
    console.error("[referral/status] error:", err);
    return NextResponse.json(
      { ok: false, reason: err?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}
