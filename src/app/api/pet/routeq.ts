import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ACCESSORIES } from "@/lib/accessories";

// ── Constants ────────────────────────────────────────────────────────────────
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT     = "0xCF8A44059652DB5Af8B4CB62938c5DC6916eB082";
// Base's own public RPC — verifies directly against the chain instead of
// going through Etherscan. Etherscan's free-tier API key does NOT cover Base
// (confirmed: "Free API access is not supported for this chain. Please
// upgrade your api plan") — every verify call was failing at the API layer,
// which the old parsing code (see git history) silently treated as "not
// confirmed yet" and burned the full 30s retry window before timing out,
// even for real, correctly-paid transactions. Base RPC needs no key or paid
// plan for eth_getTransactionReceipt. If this public endpoint's rate limits
// ever become a problem at scale, swap BASE_RPC for a provider URL (Alchemy/
// QuickNode/CDP) — the JSON-RPC shape is identical, no other code changes.
const BASE_RPC = "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Checkin price in micro-USDC
const CHECKIN_MICRO_USDC = 10_000; // $0.01

// Accessory prices in micro-USDC (6 decimals), derived from lib/accessories.ts
// (the single source of truth for the catalog) instead of a hand-maintained
// duplicate list. A hardcoded copy here previously only covered the 6 Stage 1
// items — every Stage 2/3/4 accessory (24 of 30) fell through to "Unknown
// accessory" even after a verified payment, since this map is checked BEFORE
// verifyUsdcTransfer ever runs. Deriving it from ACCESSORIES means a newly
// added accessory is priced correctly here automatically, with no separate
// edit required.
const ACCESSORY_PRICES: Record<string, number> = Object.fromEntries(
  ACCESSORIES.map((a) => [a.id, Math.round(a.costUsd * 1_000_000)]),
);

// ── Identity helper ──────────────────────────────────────────────────────────
// Grub users are identified by EITHER a Farcaster fid (Warpcast/Farcaster
// clients) OR a wallet address (Base App, which has no fid at all). Existing
// fid-keyed data keeps its original key format (`grub:pet:<fid>`) untouched,
// so no migration is needed for current Farcaster users. Wallet users get a
// new, clearly-namespaced key (`grub:pet:wallet:<address>`) so the two
// identity spaces can never collide.
function petKey(fid?: string | number | null, wallet?: string | null): string | null {
  if (fid) return `grub:pet:${fid}`;
  if (wallet) return `grub:pet:wallet:${wallet.toLowerCase()}`;
  return null;
}

// Short label used only in server logs, e.g. "fid=1234" or "wallet=0xabc...".
function identityLabel(fid?: string | number | null, wallet?: string | null): string {
  if (fid) return `fid=${fid}`;
  if (wallet) return `wallet=${wallet}`;
  return "unknown";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Verify a USDC transfer on Base via Base's own RPC — polls up to 30s
async function verifyUsdcTransfer(
  txHash: string,
  expectedMicroUsdc: number,
): Promise<{ ok: boolean; error?: string }> {
  const recipientTopic = "0x000000000000000000000000" + RECIPIENT.replace(/^0x/, "").toLowerCase();
  const expectedHex    = "0x" + expectedMicroUsdc.toString(16).padStart(64, "0");

  const deadline = Date.now() + 30_000;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      });
      const json = await res.json();

      // Standard JSON-RPC error shape: { jsonrpc, id, error: { code, message } }.
      // Distinct from "result is null" (receipt not mined yet, which is
      // expected and just means keep polling) — an actual `error` field means
      // something is wrong with the request itself (malformed hash, RPC
      // rejecting the call, etc.) and isn't worth burning the full 30s on.
      if (json?.error) {
        console.error(`[pet] Base RPC error (attempt ${attempts}): ${JSON.stringify(json.error)}`);
        return {
          ok: false,
          error: `Payment verification failed (RPC error: ${json.error.message ?? "unknown"}).`,
        };
      }

      const logs: any[] = json?.result?.logs ?? [];

      const match = logs.find(
        (l) =>
          l.address?.toLowerCase()  === USDC_CONTRACT.toLowerCase() &&
          l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.topics?.[2]?.toLowerCase() === recipientTopic &&
          l.data?.toLowerCase()     === expectedHex.toLowerCase()
      );

      if (match) return { ok: true };
      if (json?.result && logs.length > 0) {
        // Receipt exists but no matching log — tx is real but didn't pay us
        return { ok: false, error: "USDC transfer to Grub not found in transaction." };
      }
    } catch {
      // network blip — keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { ok: false, error: "Transaction not confirmed within 30s. Try again." };
}

// ── State sanitization ──────────────────────────────────────────────────────
// Applied on every save, regardless of path (unlock/checkin/regular). The
// client is trusted for most fields (hunger, bond, glimmer, etc. were already
// client-trusted before this) but two things get server-side checks because
// they're now tied to a reward (equip-XP):
//
//   1. accessories.equipped — can only contain ids the server already knows
//      are unlocked. Otherwise someone could hand-edit localStorage (or just
//      POST to this route directly, no app required) to "equip" something
//      they never paid for and start collecting equip-XP for it.
//   2. xp — capped to a generous but bounded per-save ceiling above whatever
//      the real game logic could produce in one call (core actions + one
//      equip-XP tick + a buffer). This is a mitigation, not a full fix — xp
//      itself is still client-reported, not server-recomputed from scratch.
const MAX_XP_GAIN_PER_SAVE = 25; // generous: unlock (up to 12) + one equip tick (up to 9) + a small buffer

function sanitizeState(existingRaw: any, incomingState: any) {
  const existingUnlocked: string[] = existingRaw?.accessories?.unlocked ?? [];
  const incomingUnlocked: string[] = incomingState?.accessories?.unlocked ?? [];
  const safeUnlocked = incomingUnlocked.filter((id: string) => existingUnlocked.includes(id));

  const incomingEquipped: Record<string, string> = incomingState?.accessories?.equipped ?? {};
  const safeEquipped = Object.fromEntries(
    Object.entries(incomingEquipped).filter(([, id]) => safeUnlocked.includes(id as string)),
  );

  const existingXp: number = typeof existingRaw?.xp === "number" ? existingRaw.xp : 0;
  const incomingXp: number = typeof incomingState?.xp === "number" ? incomingState.xp : existingXp;
  let safeXp = incomingXp;
  if (incomingXp - existingXp > MAX_XP_GAIN_PER_SAVE) {
    console.warn(
      `[pet] xp gain clamped — requested +${incomingXp - existingXp}, allowed +${MAX_XP_GAIN_PER_SAVE}`,
    );
    safeXp = existingXp + MAX_XP_GAIN_PER_SAVE;
  }

  return {
    ...incomingState,
    xp: safeXp,
    accessories: {
      ...incomingState?.accessories,
      unlocked: safeUnlocked,
      equipped: safeEquipped,
    },
  };
}

// ── GET — fetch pet state ────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const fid = req.nextUrl.searchParams.get("fid");
  const wallet = req.nextUrl.searchParams.get("wallet");
  const key = petKey(fid, wallet);
  if (!key) return NextResponse.json({ error: "missing fid or wallet" }, { status: 400 });

  try {
    const state = await kv.get(key);
    return NextResponse.json(state ?? null);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

// ── POST — save pet state ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, wallet, state, action, txHash } = body;
    const key = petKey(fid, wallet);
    const who = identityLabel(fid, wallet);

    if (!key || !state) {
      return NextResponse.json({ error: "missing fid/wallet or state" }, { status: 400 });
    }

    // ── Ban check — blocks ALL writes for this identity, regardless of action ─
    const currentState = await kv.get<any>(key);
    if (currentState?.banned) {
      return NextResponse.json(
        { error: "This account has been suspended." },
        { status: 403 }
      );
    }

    // ── Accessory unlock — requires verified on-chain payment ────────────────
    if (action === "unlock_accessory") {
      const { accessoryId } = body;

      if (!accessoryId || !txHash) {
        return NextResponse.json(
          { error: "unlock_accessory requires accessoryId and txHash" },
          { status: 400 }
        );
      }

      const expectedPrice = ACCESSORY_PRICES[accessoryId];
      if (!expectedPrice) {
        return NextResponse.json({ error: "Unknown accessory" }, { status: 400 });
      }

      // Replay attack prevention — each txHash can only unlock once
      const usedKey = `grub:used-tx:${txHash}`;
      const alreadyUsed = await kv.get(usedKey);
      if (alreadyUsed) {
        return NextResponse.json(
          { error: "This transaction has already been used to unlock an accessory." },
          { status: 400 }
        );
      }

      // Verify USDC transfer on-chain
      const verify = await verifyUsdcTransfer(txHash, expectedPrice);
      if (!verify.ok) {
        return NextResponse.json({ error: verify.error }, { status: 402 });
      }

      // Ensure the accessory is actually in state before saving
      const unlocked: string[] = state?.accessories?.unlocked ?? [];
      if (!unlocked.includes(accessoryId)) {
        return NextResponse.json(
          { error: "State mismatch — accessoryId not in unlocked list." },
          { status: 400 }
        );
      }

      // Save state — sanitize equipped/xp too, same as every other save path.
      // Note: the accessoryId being unlocked here is already verified by
      // payment above, so temporarily fold it into existingUnlocked before
      // sanitizing, or sanitizeState would strip the very accessory we just
      // confirmed payment for (it isn't in KV's existingUnlocked yet).
      const existingForUnlock = await kv.get<any>(key);
      const existingUnlockedList: string[] = existingForUnlock?.accessories?.unlocked ?? [];
      const sanitized = sanitizeState(
        { ...existingForUnlock, accessories: { ...existingForUnlock?.accessories, unlocked: [...existingUnlockedList, accessoryId] } },
        state,
      );
      await kv.set(key, sanitized);

      // Mark txHash as used only NOW, after the state write actually
      // succeeded (kept for 1 year). Previously this happened right after
      // payment verification but BEFORE the save below — if that save ever
      // failed (KV outage, etc.) the txHash was permanently burned with the
      // accessory never actually persisted, and no retry could ever recover
      // it since the replay guard would reject the same hash forever. Doing
      // it last means a failed save can still be retried with the same
      // txHash. Tradeoff: a tiny window now exists where two truly
      // concurrent requests with the same txHash (e.g. two tabs) could both
      // pass the verify step — acceptable, since a legitimate txHash can
      // only ever pay for one unlock's worth of USDC regardless.
      await kv.set(usedKey, { fid: fid ?? null, wallet: wallet ?? null, accessoryId, ts: Date.now() }, { ex: 60 * 60 * 24 * 365 });

      console.log(`[pet] ✅ accessory unlocked ${who} accessory=${accessoryId} tx=${txHash}`);
      return NextResponse.json({ ok: true });
    }

    // ── Paid checkin — requires verified on-chain payment ───────────────────
    if (action === "checkin") {
      if (!txHash) {
        return NextResponse.json({ error: "checkin requires txHash" }, { status: 400 });
      }

      // Replay attack prevention
      const usedKey = `grub:used-tx:${txHash}`;
      const alreadyUsed = await kv.get(usedKey);
      if (alreadyUsed) {
        return NextResponse.json(
          { error: "This transaction has already been used." },
          { status: 400 }
        );
      }

      // Verify USDC transfer on-chain
      const verify = await verifyUsdcTransfer(txHash, CHECKIN_MICRO_USDC);
      if (!verify.ok) {
        return NextResponse.json({ error: verify.error }, { status: 402 });
      }

      // Save state
      const existingForCheckin = await kv.get<any>(key);
      const sanitizedCheckin = sanitizeState(existingForCheckin, state);
      await kv.set(key, sanitizedCheckin);

      // Mark txHash as used only after the save succeeded — same reasoning
      // as the unlock_accessory path above.
      await kv.set(usedKey, { fid: fid ?? null, wallet: wallet ?? null, purpose: "checkin", ts: Date.now() }, { ex: 60 * 60 * 24 * 365 });

      console.log(`[pet] ✅ checkin saved ${who} tx=${txHash}`);
      return NextResponse.json({ ok: true });
    }

    // ── All other state saves (feeding, mood, equip, etc.) ───────────────────
    // These don't involve payment so we just save directly, after sanitizing
    // accessories.unlocked / accessories.equipped / xp against server-known state.
    const existingRaw = await kv.get<any>(key);
    const safeState = sanitizeState(existingRaw, state);

    await kv.set(key, safeState);
    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error("[pet] error:", err);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
