import { http, createConfig } from "wagmi";
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
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
