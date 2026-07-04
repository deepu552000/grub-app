// lib/pet-key.ts
//
// Grub users are identified by EITHER a Farcaster fid (Warpcast/Farcaster
// clients) OR a wallet address (Base App, which has no fid at all). Existing
// fid-keyed data keeps its original key format (`grub:pet:<fid>`) untouched,
// so no migration is needed for current Farcaster users. Wallet users get a
// new, clearly-namespaced key (`grub:pet:wallet:<address>`) so the two
// identity spaces can never collide.
//
// Extracted from app/api/pet/route.ts so /api/admin/user-control (and any
// future route) can't quietly drift out of sync with the real key format by
// hand-duplicating `grub:pet:${fid}` as a bare string.

export function petKey(fid?: string | number | null, wallet?: string | null): string | null {
  if (fid) return `grub:pet:${fid}`;
  if (wallet) return `grub:pet:wallet:${wallet.toLowerCase()}`;
  return null;
}

// Short label used only in server logs, e.g. "fid=1234" or "wallet=0xabc...".
export function identityLabel(fid?: string | number | null, wallet?: string | null): string {
  if (fid) return `fid=${fid}`;
  if (wallet) return `wallet=${wallet}`;
  return "unknown";
}
