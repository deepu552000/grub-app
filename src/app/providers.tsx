"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

// wagmi's Base Account connector pulls in Coinbase Wallet SDK, which touches
// browser-only APIs (window, telemetry) at module-load time. Next.js still
// server-renders "use client" components once during build/SSG, so a plain
// static import of that config was being evaluated on the server for every
// page — which is what threw "Telemetry is not supported in non-browser
// environments" and slowed the build down across all pages.
//
// Loading it with ssr:false keeps the wagmi module out of the server pass
// entirely; it only loads in the browser, which is the only place it was
// ever actually used anyway (Base App payment fallback). This does not
// change behavior for Farcaster, Base App, or normal browser wallet
// connections (Rabby, Coinbase, etc.) — only *when* the module loads.
const WagmiProviders = dynamic(
  () => import("./wagmi-providers").then((m) => m.WagmiProviders),
  { ssr: false }
);

export function Providers({ children }: { children: ReactNode }) {
  return <WagmiProviders>{children}</WagmiProviders>;
}
