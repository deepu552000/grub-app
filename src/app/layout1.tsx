import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import "./globals.css";
import { Providers } from "./providers";
import { wagmiConfig } from "@/lib/wagmi";

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
    "base:app_id": "6a460de62876ee6c1138a5bf",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reads the request's cookie header server-side and turns it into wagmi's
  // initial connection state — this is what lets wagmi render the SAME
  // state on the server as the client will hydrate to, now that wagmi.ts
  // uses `ssr: true` + cookieStorage. Without this, ssr:true alone has
  // nothing to read and every request still starts from a blank/disconnected
  // state on the server, which defeats the point of the wagmi.ts change.
  const initialState = cookieToInitialState(
    wagmiConfig,
    (await headers()).get("cookie"),
  );

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head />
      <body className="min-h-full flex flex-col">
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
