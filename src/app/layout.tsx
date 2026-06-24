import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Grub",
  description: "A fragile white kitty Farcaster mini app.",
  other: {
    "fc:frame": JSON.stringify({
      version: "next",
      imageUrl: "https://grub-app-eight.vercel.app/cats/stage1.webp",
      button: {
        title: "Play Grub",
        action: {
          type: "launch_frame",
          name: "Grub",
          url: "https://grub-app-eight.vercel.app",
          splashImageUrl: "https://grub-app-eight.vercel.app/cats/stage1.webp",
          splashBackgroundColor: "#f5f0e8",
        },
      },
    }),
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}