import { NextResponse } from "next/server";
import { getAllFidsForApp } from "@/lib/notification-tokens";
import { getOptedInWallets } from "@/lib/send-notification-base";

const APP_FID = 9152;
const APP_URL = "https://grub-app-eight.vercel.app";

export async function GET() {
  const fids = await getAllFidsForApp(APP_FID);

  // Base App (wallet-based) — new, additive. Wrapped so a Base API hiccup
  // can never break the FC stats above or fail the whole request.
  let baseWallets: string[] = [];
  try {
    baseWallets = await getOptedInWallets(APP_URL);
  } catch (err) {
    console.error("[stats] base wallet fetch failed:", err);
  }

  return NextResponse.json({
    // Unchanged — same fields, same meaning, same shape as before.
    totalUsers: fids.length,
    fids,
    // New — Base App wallet-based users, nested so it can't collide with
    // or be mistaken for the FC fields above.
    base: {
      totalUsers: baseWallets.length,
      wallets: baseWallets,
    },
  });
}
