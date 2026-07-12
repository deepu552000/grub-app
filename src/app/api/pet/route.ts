import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getAccessoryPriceUsd } from "@/lib/accessories";
import { grantCredit, spendCreditIfAvailable, getCredits, type CreditType } from "@/lib/grub-credits";
import { petKey, identityLabel } from "@/lib/pet-key";
import { sendDegen, recordFailedPayout, acquireLock, releaseLock, logDegenTxn } from "@/lib/referral";

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

// Spin Wheel price in micro-USDC — mirrors WHEEL_USD ($0.015) in Client.tsx.
// Kept as its own constant so the two prices (checkin vs. spin) can diverge
// without silently affecting each other.
const SPIN_MICRO_USDC = 15_000; // $0.015

// Accessory prices are now looked up LIVE per-request via
// getAccessoryPriceUsd() (lib/accessories.ts) rather than a map built once
// at module load. Two reasons this matters, not just one:
//   1. (original reason) A hardcoded copy here previously only covered the
//      6 Stage 1 items — every Stage 2/3/4 accessory (24 of 30) fell through
//      to "Unknown accessory" even after a verified payment. Deriving from
//      the catalog fixed that.
//   2. (Accessory Festival) getAccessoryPriceUsd() also applies the
//      time-gated 50%-off festival discount. A map computed once at cold
//      start would keep serving whatever price was true at that moment —
//      full or discounted — straight through the festival's start/end
//      boundary for as long as the function instance stays warm. Calling
//      the helper fresh on every request means the boundary is exact
//      regardless of server warmth, and the client (Client.tsx's
//      accessoryUnlockUsd, which calls the same helper) can never end up
//      charging a different price than this route expects.
function accessoryPriceMicroUsdc(accessoryId: string): number | null {
  const priceUsd = getAccessoryPriceUsd(accessoryId);
  if (priceUsd === null) return null;
  return Math.round(priceUsd * 1_000_000);
}

// ── Identity helper ──────────────────────────────────────────────────────────
// petKey()/identityLabel() now live in lib/pet-key.ts so other routes (e.g.
// admin/user-control) can import the exact same key format instead of
// hand-duplicating it. See that file for the fid/wallet key-format rationale.

// ── Helpers ──────────────────────────────────────────────────────────────────

// Verify a USDC transfer on Base via Base's own RPC — polls up to 30s
async function verifyUsdcTransfer(
  txHash: string,
  expectedMicroUsdc: number,
): Promise<{ ok: boolean; error?: string; fromAddress?: string }> {
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

      if (match) {
        // topics[1] is the indexed `from` address of the Transfer event
        // (32-byte padded) — the exact wallet that signed and paid for
        // this transaction. Used as the DEGEN payout destination for
        // wheel_spin degen wins below; no separate Neynar/Basename lookup
        // needed since it's read straight off the chain.
        const fromTopic = match.topics?.[1] as string | undefined;
        const fromAddress = fromTopic ? "0x" + fromTopic.slice(-40) : undefined;
        return { ok: true, fromAddress };
      }
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
//
//      This cap now SCALES with real time elapsed since the last save,
//      instead of being one flat number. Reason: equip-XP ticks (~24h each,
//      see lib/pet-accessories-state.ts) don't fire silently while a player
//      is away — they get calculated and granted all at once the next time
//      the app opens. A player back after 3 days away can legitimately have
//      3 ticks' worth of xp land in a single save. A flat 25 was sized for
//      "one unlock + one tick" and was clamping (and silently discarding)
//      that kind of ordinary, honest catch-up — this was reported as
//      "evolution deteriorating" by a real player who checked in daily.
//
//      Normal daily play only ever needs ~16-19 xp/save (see dailyLimits/
//      xpPerAction comments in Client.tsx: "~16 max XP/day, ~19/day with
//      max bond bonus") — so the 40 base alone already comfortably covers
//      same-day/same-session play with room to spare. The per-hour term is
//      there specifically for the multi-day-absence catch-up case, not for
//      day-to-day players.
//
//      Uses a SERVER-written checkpoint (_xpCapCheckpoint), not the
//      client-reported `lastVisit` — trusting a client-supplied timestamp
//      for this calculation would let the same kind of manual POST we used
//      to test this route also fake a huge elapsed-time window and blow the
//      cap open. _xpCapCheckpoint only ever gets set by this server code,
//      every successful save, so a caller can't influence it.
const XP_GAIN_BASE_CAP = 40; // baseline for same-session/same-day saves
const XP_GAIN_PER_HOUR_AWAY = 3; // extra allowance per hour since last save, for legit catch-up
const XP_GAIN_HARD_CEILING = 400; // absolute ceiling per save regardless of time away — safety net

// NOTE: freeCheckinCredits / streakSaveCredits are NO LONGER sanitized or
// accepted from the client here at all — see lib/grub-credits.ts. They now
// live in their own atomic `kv.incrby`/`kv.decrby` keys, mutated only via
// grantCredit()/spendCreditIfAvailable() below, and are stamped onto the
// saved blob (and every response) from that source of truth via
// withCreditTruth(), overwriting whatever the client sent. This closes the
// race that wiped fid 3325017's credits: a stale autosave carrying an old
// credit number can no longer overwrite a real grant or spend, because the
// client's copy of these two fields is never trusted or written anywhere.

function sanitizeState(existingRaw: any, incomingState: any) {
  const existingUnlocked: string[] = existingRaw?.accessories?.unlocked ?? [];
  const incomingUnlocked: string[] = incomingState?.accessories?.unlocked ?? [];
  // Union anchored on existingUnlocked, NOT a filter of incomingUnlocked.
  // existingUnlocked is server-confirmed truth — nothing lands in it without
  // going through unlock_accessory's verified payment or wheel_spin's
  // rare-accessory grant, and both of those callers fold the newly-verified
  // id into the `existingRaw` they pass in here before calling this. That
  // means it is always safe to just keep everything already in
  // existingUnlocked, regardless of what this particular request's
  // (possibly stale) local `incomingState` happens to know about.
  //
  // The old version filtered incomingUnlocked down to whatever existed —
  // which meant ANY save whose local snapshot didn't yet include a
  // recently-unlocked accessory (e.g. the plain 800ms debounced autosave
  // firing while a DIFFERENT accessory's unlock_accessory call was still
  // mid-flight waiting on its Etherscan verification poll) would silently
  // drop that accessory from KV when its write landed — even though it was
  // already paid for and persisted. That's what caused a 3rd purchased
  // accessory to flip back to locked after two others stuck: whichever save
  // landed last won, and the stale one's filter erased the newest unlock.
  const safeUnlocked = Array.from(new Set([
    ...existingUnlocked,
    ...incomingUnlocked.filter((id: string) => existingUnlocked.includes(id)),
  ]));

  const incomingEquipped: Record<string, string> = incomingState?.accessories?.equipped ?? {};
  const safeEquipped = Object.fromEntries(
    Object.entries(incomingEquipped).filter(([, id]) => safeUnlocked.includes(id as string)),
  );

  const existingXp: number = typeof existingRaw?.xp === "number" ? existingRaw.xp : 0;
  const incomingXp: number = typeof incomingState?.xp === "number" ? incomingState.xp : existingXp;

  // Server-trusted elapsed time since the last save. Missing on records
  // saved before this change (or on a brand-new record) — default to 0
  // hours so nobody gets a surprise free jump on migration; they just start
  // accumulating real allowance from their next save onward.
  const lastCheckpoint: number =
    typeof existingRaw?._xpCapCheckpoint === "number" ? existingRaw._xpCapCheckpoint : Date.now();
  const hoursSinceLastSave = Math.max(0, (Date.now() - lastCheckpoint) / 36e5);
  const allowedGain = Math.min(
    XP_GAIN_BASE_CAP + hoursSinceLastSave * XP_GAIN_PER_HOUR_AWAY,
    XP_GAIN_HARD_CEILING,
  );

  let safeXp = incomingXp;
  if (incomingXp - existingXp > allowedGain) {
    console.warn(
      `[pet] xp gain clamped — requested +${incomingXp - existingXp}, allowed +${Math.round(allowedGain)} ` +
        `(${hoursSinceLastSave.toFixed(1)}h since last save)`,
    );
    safeXp = existingXp + allowedGain;
  }
  // Floor: this save path (checkin/unlock/wheel_spin/generic) should never
  // be the thing that DECREASES xp — the only legitimate way xp goes down is
  // admin/user-control's adjust_stats action, which writes directly via
  // kv.set and never touches sanitizeState. Without this floor, a stale
  // autosave (e.g. one queued from just before a referral join bonus or a
  // wheel-spin xp reward applied client-side) can land AFTER the newer save
  // and silently overwrite the higher xp with its older, lower snapshot —
  // same shape of race that used to wipe freeCheckinCredits/streakSaveCredits
  // before those got their own atomic kv.incrby/decrby keys (see
  // lib/grub-credits.ts). XP doesn't have an atomic counter to fall back on
  // the same way, so a floor is the minimal fix: whichever save lands last,
  // xp can only ever go up or stay the same, never regress.
  if (safeXp < existingXp) {
    console.warn(
      `[pet] xp decrease blocked — incoming ${incomingXp} < existing ${existingXp}, keeping ${existingXp}`,
    );
    safeXp = existingXp;
  }

  return {
    ...incomingState,
    xp: safeXp,
    // Server-trusted timestamp for the next save's time-scaled xp cap —
    // always refreshed here (not just when xp changes), since what we're
    // measuring is "how long since this record was last touched by our own
    // server code," and that's exactly what stays stale while a player is
    // genuinely away (no saves happen at all while the app isn't running).
    _xpCapCheckpoint: Date.now(),
    accessories: {
      ...incomingState?.accessories,
      unlocked: safeUnlocked,
      equipped: safeEquipped,
    },
  };
}

// Stamps the real atomic credit values onto a state object, overwriting
// whatever (possibly stale, possibly fabricated) numbers were already on it.
// Call this immediately before every kv.set of the pet blob, and on every
// GET, so the blob's freeCheckinCredits/streakSaveCredits fields are always
// just a mirror of the atomic keys — never an independent source of truth.
async function withCreditTruth(key: string, obj: any) {
  const credits = await getCredits(key);
  return { ...obj, ...credits };
}

// ── GET — fetch pet state ────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const fid = req.nextUrl.searchParams.get("fid");
  const wallet = req.nextUrl.searchParams.get("wallet");
  const key = petKey(fid, wallet);
  if (!key) return NextResponse.json({ error: "missing fid or wallet" }, { status: 400 });

  try {
    const state = await kv.get<any>(key);
    if (!state) return NextResponse.json(null);
    // Always answer with the real atomic credit values, never the blob's
    // (possibly stale) copy — see withCreditTruth().
    return NextResponse.json(await withCreditTruth(key, state));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

// ── POST — save pet state ────────────────────────────────────────────────────
// Logs every rejection with a consistent [pet] ❌ prefix + the identity/action
// context, then returns the NextResponse. Added after a run of 3 back-to-back
// accessory unlocks silently failed with 400s and NOTHING showed up in the
// Vercel log Messages column — every early-return branch below was bare
// `NextResponse.json(...)` with no console output at all, so there was no way
// to tell WHICH check rejected the request without reproducing it with local
// devtools open. Every rejection path in this file should route through this
// instead of returning NextResponse.json directly.
function logReject(status: number, reason: string, details: Record<string, any> = {}) {
  console.warn(`[pet] ❌ ${status} ${reason}`, details);
  return NextResponse.json({ error: reason }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fid, wallet, state, action, txHash } = body;
    const key = petKey(fid, wallet);
    const who = identityLabel(fid, wallet);

    if (!key || !state) {
      return logReject(400, "missing fid/wallet or state", { fid, wallet, action, hasState: !!state });
    }

    // ── Ban check — blocks ALL writes for this identity, regardless of action ─
    const currentState = await kv.get<any>(key);
    if (currentState?.banned) {
      return logReject(403, "This account has been suspended.", { who, action });
    }

    // ── Accessory unlock — requires verified on-chain payment ────────────────
    if (action === "unlock_accessory") {
      const { accessoryId } = body;

      if (!accessoryId || !txHash) {
        return logReject(400, "unlock_accessory requires accessoryId and txHash", {
          who, accessoryId, hasTxHash: !!txHash,
        });
      }

      const expectedPrice = accessoryPriceMicroUsdc(accessoryId);
      if (expectedPrice === null) {
        return logReject(400, "Unknown accessory", { who, accessoryId });
      }

      // Replay attack prevention — each txHash can only unlock once
      const usedKey = `grub:used-tx:${txHash}`;
      const alreadyUsed = await kv.get(usedKey);
      if (alreadyUsed) {
        // Logged in full (not just a flag) — this is the single most useful
        // signal for diagnosing a back-to-back-purchase failure: it tells
        // you exactly which accessory/identity/timestamp actually burned
        // this txHash, so you can see whether THIS request really is a
        // dupe/retry of an earlier success, or something reused a hash it
        // shouldn't have (e.g. a stale txHash carried over from a prior
        // unlock's closure).
        return logReject(400, "This transaction has already been used to unlock an accessory.", {
          who, accessoryId, txHash, previouslyUsedFor: alreadyUsed,
        });
      }

      // Verify USDC transfer on-chain
      const verify = await verifyUsdcTransfer(txHash, expectedPrice);
      if (!verify.ok) {
        console.warn(`[pet] ❌ 402 verifyUsdcTransfer failed`, { who, accessoryId, txHash, expectedPrice, reason: verify.error });
        return NextResponse.json({ error: verify.error }, { status: 402 });
      }

      // Ensure the accessory is actually in state before saving
      const unlocked: string[] = state?.accessories?.unlocked ?? [];
      if (!unlocked.includes(accessoryId)) {
        return logReject(400, "State mismatch — accessoryId not in unlocked list.", {
          who, accessoryId, txHash, incomingUnlocked: unlocked,
        });
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
      await kv.set(key, await withCreditTruth(key, sanitized));

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
        return logReject(400, "checkin requires txHash", { who });
      }

      // Replay attack prevention
      const usedKey = `grub:used-tx:${txHash}`;
      const alreadyUsed = await kv.get(usedKey);
      if (alreadyUsed) {
        return logReject(400, "This transaction has already been used.", {
          who, txHash, previouslyUsedFor: alreadyUsed,
        });
      }

      // Verify USDC transfer on-chain
      const verify = await verifyUsdcTransfer(txHash, CHECKIN_MICRO_USDC);
      if (!verify.ok) {
        console.warn(`[pet] ❌ 402 verifyUsdcTransfer failed`, { who, txHash, reason: verify.error });
        return NextResponse.json({ error: verify.error }, { status: 402 });
      }

      // Save state
      const existingForCheckin = await kv.get<any>(key);
      const sanitizedCheckin = sanitizeState(existingForCheckin, state);
      await kv.set(key, await withCreditTruth(key, sanitizedCheckin));

      // Mark txHash as used only after the save succeeded — same reasoning
      // as the unlock_accessory path above.
      await kv.set(usedKey, { fid: fid ?? null, wallet: wallet ?? null, purpose: "checkin", ts: Date.now() }, { ex: 60 * 60 * 24 * 365 });

      console.log(`[pet] ✅ checkin saved ${who} tx=${txHash}`);
      return NextResponse.json({ ok: true });
    }

    // ── Spin Wheel — requires verified on-chain payment ──────────────────────
    // Previously "wheel_spin" wasn't handled here at all — Client.tsx sends it
    // (see the comment there: "this expects a corresponding update to the
    // /api/pet route to accept action: 'wheel_spin'"), but with no matching
    // branch it fell straight through to the generic save at the bottom. That
    // meant two problems at once: (1) the $0.01 spin payment was never
    // actually verified server-side — a fabricated txHash would still "win",
    // and (2) freeCheckinCredits/streakSaveCredits were saved as whatever
    // absolute number was in the client's `state` snapshot at that moment. If
    // a slightly-stale save (e.g. the debounced 800ms autosave elsewhere in
    // Client.tsx, or an in-flight request from an earlier action) landed
    // AFTER a spin win, its older, lower credit count would silently overwrite
    // the win — nothing here blocked a decrease, only an inflated increase.
    // That's what happened to fid 3325017: two wins landed, then a stale save
    // wiped both back to 0.
    //
    // Fix: verify payment like every other paid action, then compute the
    // credited amount from a FRESH kv.get taken right before the write —
    // never from the client's own (possibly stale) copy of these two fields.
    // This can't fully eliminate every possible interleaving without true
    // atomic counters, but it removes the two biggest windows: no more
    // trusting an unverified payment, and no more trusting a stale client
    // number for the one thing (+1 credit) the server can compute itself.
    if (action === "wheel_spin") {
      const { wheelReward, accessoryId } = body;

      if (!txHash) {
        return logReject(400, "wheel_spin requires txHash", { who, wheelReward });
      }

      // Replay attack prevention — same pattern as checkin/unlock_accessory
      const usedKey = `grub:used-tx:${txHash}`;
      const alreadyUsed = await kv.get(usedKey);
      if (alreadyUsed) {
        return logReject(400, "This transaction has already been used.", {
          who, txHash, wheelReward, previouslyUsedFor: alreadyUsed,
        });
      }

      // Verify the $0.01 spin payment on-chain
      const verify = await verifyUsdcTransfer(txHash, SPIN_MICRO_USDC);
      if (!verify.ok) {
        console.warn(`[pet] ❌ 402 verifyUsdcTransfer failed`, { who, txHash, wheelReward, reason: verify.error });
        return NextResponse.json({ error: verify.error }, { status: 402 });
      }

      const existingForSpin = await kv.get<any>(key);

      const serverComputed: Record<string, any> = {};
      if (wheelReward === "freecheckin") {
        // Atomic INCRBY — replaces the old read-then-write on the JSON blob.
        // See lib/grub-credits.ts for why: two concurrent writes here could
        // never step on each other now, regardless of what else is saving
        // the blob at the same moment.
        serverComputed.freeCheckinCredits = await grantCredit(key, "freeCheckin");
      } else if (wheelReward === "freecheckin2") {
        // "Free Check-in ×2" — single atomic +2 grant (grantCredit already
        // takes an amount param, so this is one INCRBY, not two calls).
        serverComputed.freeCheckinCredits = await grantCredit(key, "freeCheckin", 2);
      } else if (wheelReward === "streaksave") {
        serverComputed.streakSaveCredits = await grantCredit(key, "streakSave");
      } else if (wheelReward === "streaksave2") {
        serverComputed.streakSaveCredits = await grantCredit(key, "streakSave", 2);
      } else if (wheelReward === "rareaccessory") {
        if (!accessoryId) {
          return logReject(400, "rareaccessory reward requires accessoryId", { who, txHash });
        }
        const existingUnlocked: string[] = existingForSpin?.accessories?.unlocked ?? [];
        if (!existingUnlocked.includes(accessoryId)) {
          serverComputed.accessories = {
            ...existingForSpin?.accessories,
            unlocked: [...existingUnlocked, accessoryId],
          };
        }
      }
      // xp / degen10 / degen15 have no dedicated pet-state field. XP falls
      // through to sanitizeState's existing xp cap below, same as any other
      // save. DEGEN is settled separately, on-chain, after the state write —
      // see the payout block below.

      // serverComputed spreads LAST so it always wins over both the client's
      // `state` and the pre-write existingForSpin snapshot for these fields.
      const merged = { ...existingForSpin, ...state, ...serverComputed };

      // Fold serverComputed.accessories into the baseline BEFORE sanitizing —
      // otherwise sanitizeState strips the very accessory this call just
      // granted right back out, because its own "existingUnlocked" (read
      // from KV before this grant happened) doesn't know about it yet. This
      // is the exact same trap unlock_accessory's comment above already
      // warns about — that path was patched, this one (rareaccessory via the
      // wheel) was missed, which silently discarded every wheel-won rare
      // accessory: the client showed the win, the save reported ok:true, but
      // the accessory was never actually persisted, so it vanished on the
      // next load.
      const existingForSanitize = serverComputed.accessories
        ? { ...existingForSpin, accessories: serverComputed.accessories }
        : existingForSpin;
      const sanitized = sanitizeState(existingForSanitize, merged);
      const finalState = await withCreditTruth(key, sanitized);
      await kv.set(key, finalState);

      await kv.set(usedKey, { fid: fid ?? null, wallet: wallet ?? null, purpose: "wheel_spin", wheelReward: wheelReward ?? null, ts: Date.now() }, { ex: 60 * 60 * 24 * 365 });

      console.log(`[pet] ✅ wheel spin saved ${who} reward=${wheelReward ?? "unknown"} tx=${txHash}`);

      // ── DEGEN payout — degen10 / degen15 ────────────────────────────────
      // The spin itself is already fully paid-for and persisted above,
      // regardless of what happens here. Destination = verify.fromAddress,
      // the exact wallet that signed the USDC spin payment, read straight
      // off the on-chain Transfer log above — same sendDegen()/lock/
      // recordFailedPayout pipeline as referral payouts (lib/referral.ts),
      // just a different (on-chain, not Neynar) way of resolving the one
      // address it needs. If the DEGEN transfer itself fails, the failure
      // is logged for retry in the same admin dashboard referral failures
      // show up in — the player still keeps their spin result either way.
      let degenPayout: { ok: boolean; amountDegen: number; txHash?: string; reason?: string } | null = null;

      if (wheelReward === "degen10" || wheelReward === "degen15") {
        const amountDegen = wheelReward === "degen10" ? 10 : 15;
        const payoutWallet = verify.fromAddress;
        const payoutIdentity = fid ? Number(fid) : `wallet:${wallet}`;

        if (!payoutWallet) {
          console.error(`[pet] ❌ wheel degen payout has no fromAddress`, { who, txHash, wheelReward });
          await recordFailedPayout({
            fid: payoutIdentity,
            toFid: payoutIdentity,
            toWallet: "unknown",
            amountDegen,
            type: "wheel_degen",
            reason: "Could not determine payer wallet from on-chain transfer log.",
            sideEffect: null,
          });
          degenPayout = { ok: false, amountDegen, reason: "Could not determine payout wallet." };
        } else {
          // Locked by txHash (unique per spin) so a duplicate/racing request
          // for the same spin can't ever trigger two DEGEN sends — mirrors
          // the referral checkin/register payout locks in lib/referral.ts.
          const payoutLockKey = `grub:wheel-degen-payout:${txHash}`;
          const gotPayoutLock = await acquireLock(payoutLockKey, 30);
          if (!gotPayoutLock) {
            console.warn(`[pet] wheel degen payout for tx ${txHash} already in progress, skipping duplicate`);
            degenPayout = { ok: false, amountDegen, reason: "Payout already in progress elsewhere." };
          } else {
            try {
              let degenTxHash: string;
              try {
                degenTxHash = await sendDegen(payoutWallet, amountDegen);
              } catch (err: any) {
                console.error("[pet] wheel degen sendDegen failed:", err);
                await recordFailedPayout({
                  fid: payoutIdentity,
                  toFid: payoutIdentity,
                  toWallet: payoutWallet,
                  amountDegen,
                  type: "wheel_degen",
                  reason: err?.reason ?? err?.shortMessage ?? err?.message ?? "unknown error",
                  broadcastTxHash: err?.broadcastTxHash ?? null,
                  sideEffect: null,
                });
                return NextResponse.json({
                  ok: true,
                  freeCheckinCredits: finalState.freeCheckinCredits,
                  streakSaveCredits: finalState.streakSaveCredits,
                  degenPayout: { ok: false, amountDegen, reason: "DEGEN payout failed — logged for retry in dashboard." },
                });
              }

              await logDegenTxn({
                fid: payoutIdentity,
                toFid: payoutIdentity,
                type: "wheel_degen",
                txHash: degenTxHash,
                amountDegen,
                toWallet: payoutWallet,
              });

              console.log(`[pet] ✅ wheel degen paid ${amountDegen} DEGEN to ${payoutWallet} tx=${degenTxHash}`);
              degenPayout = { ok: true, amountDegen, txHash: degenTxHash };
            } finally {
              await releaseLock(payoutLockKey);
            }
          }
        }
      }

      // Return the actual post-grant credit balance so the client can sync
      // its optimistic local bump to the real server number instead of
      // trusting its own guess, plus the DEGEN payout result (if any).
      return NextResponse.json({
        ok: true,
        freeCheckinCredits: finalState.freeCheckinCredits,
        streakSaveCredits: finalState.streakSaveCredits,
        degenPayout,
      });
    }

    // ── Atomic credit spend — Free Check-in or Streak Save being consumed ────
    // Called by the client the moment it wants to use a banked credit
    // (starting a free check-in, or auto-saving a streak on a missed day),
    // BEFORE it commits that locally. This is what makes consumption safe:
    // previously spends only ever happened by the client mutating its own
    // React state and letting the regular debounced autosave carry the
    // decremented number down — which is exactly the shape of race that can
    // wipe a credit (a stale in-flight autosave with an old, higher number
    // landing after a real spend). kv.decrby is atomic, so two overlapping
    // spend attempts (or a spend overlapping a stale autosave) can't corrupt
    // the count anymore — and a stale autosave can no longer write a credit
    // number at all, since withCreditTruth() always overwrites it on save.
    if (action === "consume_credit") {
      const { creditType } = body as { creditType?: CreditType };
      if (creditType !== "freeCheckin" && creditType !== "streakSave") {
        return NextResponse.json(
          { error: `creditType must be "freeCheckin" or "streakSave", got "${creditType}"` },
          { status: 400 },
        );
      }

      const newValue = await spendCreditIfAvailable(key, creditType);
      if (newValue === null) {
        return NextResponse.json({ ok: false, error: "No credit available to spend." }, { status: 409 });
      }

      // Mirror into the blob too, so GET / the debug-kv dashboard stay
      // accurate without a second round trip. The atomic key is still the
      // real source of truth.
      const existing = await kv.get<any>(key);
      if (existing) {
        await kv.set(key, await withCreditTruth(key, existing));
      }

      return NextResponse.json({ ok: true, creditType, remaining: newValue });
    }

    // ── All other state saves (feeding, mood, equip, etc.) ───────────────────
    // These don't involve payment so we just save directly, after sanitizing
    // accessories.unlocked / accessories.equipped / xp against server-known state.
    const existingRaw = await kv.get<any>(key);
    const safeState = sanitizeState(existingRaw, state);

    await kv.set(key, await withCreditTruth(key, safeState));
    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error("[pet] error:", err);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
