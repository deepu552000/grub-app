"use client";

import type { ReactNode } from "react";

// Client.tsx only calls wagmi's imperative action functions (connect,
// getAccount, reconnect, sendTransaction, switchChain, watchAccount — all
// from "wagmi/actions"), passing `wagmiConfig` directly as an argument each
// time. None of that needs React context — <WagmiProvider> and
// <QueryClientProvider> only matter for wagmi's HOOK-based API (useAccount,
// useConnect, etc.) and react-query hooks, and this app uses neither.
//
// Wrapping children in <WagmiProvider> was what triggered the "Telemetry is
// not supported in non-browser environments" build error in the first place
// (it does some synchronous browser-only work on mount). Deferring it with
// dynamic(..., { ssr: false }) fixed the build, but it also meant the whole
// app (children) didn't render until that separate chunk finished loading —
// which is what caused the black screen in Base App's in-app browser.
//
// Since nothing actually needs the context, the correct fix is to just not
// provide it. wagmiConfig itself still works exactly the same for
// connect/getAccount/etc. because Client.tsx imports it directly.
export function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
