import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import Script from "next/script";

// ── TEMPORARY DEBUG TOOL ─────────────────────────────────────────────────
// Shows any uncaught error or unhandled promise rejection directly on
// screen, in plain DOM (no React), so it still shows up even if React's
// own tree crashes and goes blank. Runs before React hydrates.
// REMOVE this <Script> block once the Base App blank-screen issue is found.
const debugOverlayScript = `
(function () {
  function showOverlay(text) {
    var el = document.getElementById('grub-debug-overlay');
    if (el) { el.textContent += "\\n\\n" + text; return; }
    el = document.createElement('div');
    el.id = 'grub-debug-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);color:#7CFC7C;font-family:monospace;font-size:12px;padding:14px;z-index:2147483647;overflow:auto;white-space:pre-wrap;';
    el.textContent = text;
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(el);
    });
    if (document.body) document.body.appendChild(el);
  }
  window.addEventListener('error', function (e) {
    showOverlay('JS ERROR: ' + e.message + '\\nat ' + (e.filename || '?') + ':' + (e.lineno || '?') + '\\n' + (e.error && e.error.stack ? e.error.stack : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showOverlay('UNHANDLED PROMISE REJECTION: ' + (r && r.message ? r.message : String(r)) + '\\n' + (r && r.stack ? r.stack : ''));
  });
})();
`;

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
      <head>
        <Script id="grub-debug-overlay" strategy="beforeInteractive">
          {debugOverlayScript}
        </Script>
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
