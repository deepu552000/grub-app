import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";

// Used only as the fallback path when Grub is NOT running inside a Farcaster
// host (i.e. sdk.wallet.getEthereumProvider() isn't available — this is the
// Base App / plain-browser case since Base App stopped treating mini apps as
// Farcaster mini apps on April 9, 2026). The Farcaster payment path in
// Client.tsx does not use this config at all.
export const wagmiConfig = createConfig({
  chains: [base],
  // Avoids wagmi auto-picking a random injected provider over Base Account.
  multiInjectedProviderDiscovery: false,
  connectors: [
    baseAccount({
      appName: "Grub",
    }),
  ],
  transports: {
    [base.id]: http(),
  },
  // CRITICAL for Next.js SSR (App Router server-renders "use client"
  // components too, including Providers/Client.tsx). Without this, wagmi
  // reads its persisted connection state from localStorage synchronously on
  // its very FIRST render — but localStorage doesn't exist during the
  // server-rendered pass, so that pass always renders "disconnected." When
  // the client then hydrates and immediately re-reads the real (possibly
  // connected) localStorage state, server and client disagree about what
  // was rendered — a hydration mismatch. React's recovery from that
  // mismatch is to discard and re-render the affected subtree, which is
  // what shows up here as "identity slow / needs two refreshes" and a
  // wallet switch not being picked up cleanly. `ssr: true` tells wagmi to
  // render a neutral/disconnected state on both the server AND the client's
  // FIRST paint, then hydrate the real connection state right after mount —
  // so server and client always agree on that first render, no mismatch,
  // no discarded subtree.
  ssr: true,
  // cookieStorage (not localStorage) so the persisted connection state can
  // actually be read during SSR in the first place — localStorage is never
  // available server-side no matter what. This pairs with ssr:true above;
  // using ssr:true with the default localStorage-based storage would still
  // leave the server with nothing to read.
  storage: createStorage({ storage: cookieStorage }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
