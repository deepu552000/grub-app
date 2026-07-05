"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

// Wraps the app with Wagmi + React Query so the Base Account connector is
// available as a payment fallback for Base App users. This is purely
// additive — it doesn't change how the app behaves inside Farcaster/Warpcast,
// since that path never touches wagmi at all.
//
// `initialState` is produced server-side in layout.tsx (via wagmi's
// cookieToInitialState, reading the request's cookies) and passed straight
// through here. This is what pairs with wagmi.ts's `ssr: true` +
// cookieStorage: WagmiProvider uses this to render the SAME connection
// state on the server's first pass and the client's first paint, instead of
// server always rendering "disconnected" and the client immediately
// overwriting it once it can read storage — that mismatch was the root
// cause of "identity slow, needs two refreshes" and wallet-switches not
// being picked up cleanly.
export function Providers({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: State;
}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
