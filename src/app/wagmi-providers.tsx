"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

// Same as before — Base Account connector as a payment fallback for Base App
// users. Farcaster/Warpcast never touches this at all (see Client.tsx).
// This file is only ever loaded dynamically (see ./providers.tsx) so its
// module body — and therefore wagmiConfig / Coinbase Wallet SDK's init code —
// never runs during the server-side build/SSG pass.
export function WagmiProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
