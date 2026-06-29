// app/page.tsx  ← REPLACE your existing page.tsx with this file
//
// This is a SERVER component wrapper that:
// 1. Reads ?ref= from the URL and injects it into the fc:frame embed URL
// 2. Renders the actual Client component
//
// Your existing page.tsx content moves to app/Client.tsx (see other file)

import type { Metadata } from "next";
import ClientPage from "./Client";

const BASE_URL = "https://grub-app-eight.vercel.app";
const IMAGE_URL = `${BASE_URL}/cats/stage1.webp`;

type Props = {
  searchParams: Promise<{ ref?: string }>;
};

// Dynamically generates fc:frame metadata — includes ?ref= if present
// so when someone clicks a referral cast embed, the app opens with the ref param
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams;
  const ref = params?.ref;

  const appUrl = ref ? `${BASE_URL}/?ref=${ref}` : BASE_URL;

  return {
    title: "Grub",
    description: "A fragile white kitty Farcaster mini app.",
    other: {
      "fc:frame": JSON.stringify({
        version: "next",
        imageUrl: IMAGE_URL,
        button: {
          title: "Play Grub 🐱",
          action: {
            type: "launch_frame",
            name: "Grub",
            url: appUrl,           // ← includes ?ref= when present
            splashImageUrl: IMAGE_URL,
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
