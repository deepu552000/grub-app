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
      <head>
        {/*
          Runs before React hydrates. Catches failures that happen so early
          they'd never reach the handlers set up inside Client.tsx's mount
          effect (JS parse errors, a chunk failing to load, etc.) — these
          are exactly the kind of failure that could leave a cold Base App
          launch stuck on a black screen with nothing else ever firing.
          Fire-and-forget, must never throw itself.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var sid = "pre-" + Math.random().toString(36).slice(2) + "-" + Date.now();
                  function beacon(stage, extra) {
                    try {
                      fetch("/api/mount-log", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        keepalive: true,
                        body: JSON.stringify({ session: sid, stage: stage, extra: extra || null })
                      }).catch(function () {});
                    } catch (e) {}
                  }
                  beacon("pre-hydrate-script-start");
                  window.addEventListener("error", function (e) {
                    beacon("pre-hydrate-window-error", {
                      message: e.message,
                      filename: e.filename,
                      lineno: e.lineno
                    });
                  });
                  window.addEventListener("unhandledrejection", function (e) {
                    beacon("pre-hydrate-unhandled-rejection", { reason: String(e.reason) });
                  });
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
