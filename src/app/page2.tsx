// app/page.tsx  ← REPLACE your existing page.tsx with this file
//
// This is a SERVER component wrapper that:
// 1. Reads ?ref= and the share stats (?stage=&mood=&xp=&streak=&bond=) from the URL
// 2. Builds the fc:frame embed so the share card image IS the launcher into the app
// 3. Renders the actual Client component
//
// Your existing page.tsx content stays in app/Client.tsx — unchanged.

import type { Metadata } from "next";
import ClientPage from "./Client";

const BASE_URL = "https://grub-app-eight.vercel.app";

// Fallback image used when this page is opened with no share stats in the URL
// (e.g. someone just visits the bare app link, not a shared cast).
const DEFAULT_IMAGE_URL = `${BASE_URL}/cats/stage1.webp`;

type Props = {
  searchParams: Promise<{
    ref?: string;
    stage?: string;
    mood?: string;
    xp?: string;
    streak?: string;
    bond?: string;
    // Spin Wheel win banner — optional, only present when shareWheelWin()
    // built this URL. See Client.tsx's shareWheelWin() and the share-card
    // route for what these render as.
    win?: string;
    rare?: string;
  }>;
};

// Dynamically generates fc:frame metadata.
// - Always includes ?ref= in the launch URL when present, so referral tracking
//   survives the tap-through.
// - If share stats are present (stage/mood/xp/streak/bond), the preview image
//   becomes the dynamic /api/share-card card instead of the static stage1 art —
//   so the rich stat card people see in the cast is the SAME thing that launches
//   the app when tapped, instead of a separate non-clickable image embed.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams;
  const { ref, stage, mood, xp, streak, bond, win, rare } = params ?? {};

  const hasShareStats = Boolean(stage && mood);

  // Build the launch URL — always carries ?ref= when present. We deliberately
  // do NOT carry stage/mood/xp/streak/bond into the launch URL: those describe
  // the state of the pet at share-time, not "what to open the app to."
  const appUrl = ref ? `${BASE_URL}/?ref=${ref}` : BASE_URL;

  // Build the OG image URL — the live share-card if we have stats, else the
  // static fallback image.
  let imageUrl = DEFAULT_IMAGE_URL;
  if (hasShareStats) {
    const cardParams = new URLSearchParams();
    if (stage)  cardParams.set("stage", stage);
    if (mood)   cardParams.set("mood", mood);
    if (xp)     cardParams.set("xp", xp);
    if (streak) cardParams.set("streak", streak);
    if (bond)   cardParams.set("bond", bond);
    // Spin Wheel win banner — purely additive, doesn't change hasShareStats
    // (a win is always accompanied by stage/mood anyway, since shareWheelWin()
    // builds its URL the same way shareKitty() does).
    if (win)    cardParams.set("win", win);
    if (rare)   cardParams.set("rare", rare);
    imageUrl = `${BASE_URL}/api/share-card?${cardParams.toString()}`;
  }

  return {
    title: "Grub",
    description: "A fragile white kitty Farcaster mini app.",
    other: {
      "fc:frame": JSON.stringify({
        version: "next",
        imageUrl,
        button: {
          title: "Play Grub 🐱",
          action: {
            type: "launch_frame",
            name: "Grub",
            url: appUrl,                 // ← includes ?ref= when present
            splashImageUrl: DEFAULT_IMAGE_URL,
            splashBackgroundColor: "#f5f0e8",
          },
        },
      }),
    },
  };
}

// Just renders the client component — no change to UI
export default function Page() {
  return <ClientPage />;
}
