"use client";

import sdk from "@farcaster/miniapp-sdk";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState, useRef } from "react";
import { ACCESSORIES, getAccessoriesForStage, getPosition, accessoriesAllowedFor, canEquipForStage, groupEquippedByLayer, type Accessory, type AccessorySlot } from "@/lib/accessories";
import {
  type AccessoryState,
  createEmptyAccessoryState,
  isUnlocked,
  isEquipped,
  unlockAccessory,
  equipAccessory,
  removeAccessory,
  getEquippedForStage,
} from "@/lib/pet-accessories-state";

type Mood = "content" | "smug" | "hungry" | "feral" | "sleepy";
type ActionType = "feed" | "play" | "groom" | "nap";

type PetState = {
  hunger: number;
  happiness: number;
  energy: number;
  care: number;
  bond: number;
  xp: number;
  glimmer: number;
  streak: number;
  lastVisit: number;
  lastCareDay: string;
  lastTapDay: string;
  lastTapAt: number;
  actionsToday: Record<ActionType, number>;
  tapsToday: number;
  lastCheckInDay: string;
  checkinStreak: number;
  checkinHistory: string[]; // last 7 day-keys that were checked in
  totalCheckIns: number; // lifetime check-in count, first 5 are free
  lastEventDay: string;  // date key of last applied daily event
  accessories: AccessoryState;
};

type FloatingNumber = {
  id: number;
  text: string;
  x: number;
  y: number;
};

type Ripple = {
  id: number;
  x: number;
  y: number;
};

const STORAGE_KEY = "grub-white-kitty-v1";

const stages = [
  {
    name: "Tiny Cloud",
    title: "Newborn",
    minXp: 0,
    note: "Small, wobbly, and learning that your hand means food.",
    world: "Blanket nest",
  },
  {
    name: "Pocket Purr",
    title: "Kitten",
    minXp: 480,
    note: "Curious, playful, and starting to recognize your care.",
    world: "Soft playroom",
  },
  {
    name: "Pearl Floof",
    title: "Young Cat",
    minXp: 960,
    note: "Graceful now, but still melts when you groom her.",
    world: "Pearl window",
  },
  {
    name: "Moonmilk Mythic",
    title: "Adult Mythic",
    minXp: 1440,
    note: "Fully bonded. This is the future NFT form, alive with traits.",
    world: "Moon garden",
  },
];

const dialogue: Record<Mood, string[]> = {
  content: [
    "I saved one tiny purr for you. Do not waste it.",
    "Fine. I am comfortable. This changes nothing.",
    "You may continue being useful.",
  ],
  smug: [
    "I evolved because I am excellent. You were also present.",
    "Look at me. Carefully. This is premium floof.",
    "I found sparkle. Naturally.",
  ],
  hungry: [
    "My bowl is empty and somehow this is society now.",
    "I am not mad. I am just extremely unfed.",
    "A dramatic collapse is scheduled unless snacks arrive.",
  ],
  feral: [
    "You vanished. I became folklore.",
    "I no longer answer to names. Only offerings.",
    "I hid a treat from myself and still blamed you.",
  ],
  sleepy: [
    "Tiny nap. Major emotional recovery.",
    "Purring in low power mode.",
    "I dreamed I was a very expensive cloud.",
  ],
};

// Lines said specifically when you poke/pat the cat directly (not a care action)
const pokeLines: Record<Mood, string[]> = {
  content: ["hey.", "that's my head.", "...again, but gently."],
  smug: ["yes, you may touch greatness.", "obviously."],
  hungry: ["pet later. food now.", "this is not food."],
  feral: ["do NOT.", "i bite now. i told you."],
  sleepy: ["...zzz...what.", "five more minutes."],
};

// Bond tiers - the single source of truth for both dialogue unlocks and the XP
// bonus. Both now move together at the same checkpoints: hit a threshold, get
// the new lines AND the new bonus, all at once. Never punishes - below 25 is
// simply +0%, identical to before Bond existed.
const bondTiers: { threshold: number; xpBonusPct: number; lines: string[] }[] = [
  {
    threshold: 25,
    xpBonusPct: 5,
    lines: ["okay. you're alright, i guess.", "fine, you've earned a little trust."],
  },
  {
    threshold: 50,
    xpBonusPct: 10,
    lines: ["you again. good.", "i was hoping it'd be you."],
  },
  {
    threshold: 75,
    xpBonusPct: 15,
    lines: ["don't tell the others, but you're my favorite.", "i'd share my nap spot with you."],
  },
  {
    threshold: 100,
    xpBonusPct: 20,
    lines: ["you're stuck with me now. forever. it's fine.", "this is the part where i admit i missed you."],
  },
];

function unlockedMilestoneLines(bond: number): string[] {
  return bondTiers.filter((tier) => bond >= tier.threshold).flatMap((tier) => tier.lines);
}

// How many times each care action can be used per day.
// XP tuned for ~16 max XP/day → ~90 days to Mythic (3 months).
// With max bond bonus (+20%): ~19/day. 7-day streak adds +5 XP bonus drop.
const dailyLimits: Record<ActionType, number> = {
  feed: 3,
  play: 2,
  groom: 2,
  nap: 1,
};

const xpPerAction: Record<ActionType, number> = {
  feed: 3,
  play: 2,
  groom: 2,
  nap: 1,
};

// Stepped bond bonus - looks up the highest tier reached, rather than scaling
// continuously. Below the first threshold (25), bonus is 0%.
function bondXpBonusPct(bond: number): number {
  const reached = bondTiers.filter((tier) => clamp(bond) >= tier.threshold);
  if (reached.length === 0) return 0;
  return reached[reached.length - 1].xpBonusPct;
}

function bondXpMultiplier(bond: number): number {
  return 1 + bondXpBonusPct(bond) / 100;
}

// Tapping the cat directly builds Bond only - no XP, no glimmer.
// It's the "I just like my pet" action, separate from managing its needs.
const BOND_PER_TAP = 1;
const BOND_TAP_DAILY_CAP = 20; // soft ceiling so tapping can't be macro'd for infinite bond

// Bond decays if you stop tapping - a 24h grace period (missing one day costs nothing),
// then 1 point lost per hour past that. Roughly: 1 day missed = no penalty,
// 2 days missed = about half gone, 3 days missed = nearly all gone.
const BOND_DECAY_GRACE_HOURS = 24;
const BOND_DECAY_PER_HOUR = 1;

const defaultState: PetState = {
  hunger: 62,
  happiness: 58,
  energy: 70,
  care: 54,
  bond: 30,
  xp: 0,
  glimmer: 24,
  streak: 0,
  lastVisit: Date.now(),
  lastCareDay: "",
  lastTapDay: "",
  lastTapAt: Date.now(),
  actionsToday: { feed: 0, play: 0, groom: 0, nap: 0 },
  tapsToday: 0,
  lastCheckInDay: "",
  checkinStreak: 0,
  checkinHistory: [],
  totalCheckIns: 0,
  lastEventDay: "",
  accessories: createEmptyAccessoryState(),
};

function clamp(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getStage(xp: number) {
  return [...stages].reverse().find((stage) => xp >= stage.minXp) ?? stages[0];
}

function getNextStage(xp: number) {
  return stages.find((stage) => stage.minXp > xp);
}

function moodFor(state: PetState): Mood {
  const awayHours = (Date.now() - state.lastVisit) / 36e5;

  if (awayHours > 72 || state.hunger < 18 || state.care < 16) return "feral";
  if (new Date().getHours() >= 23 || new Date().getHours() < 5) return "sleepy";
  if (state.hunger < 38) return "hungry";
  if (state.happiness > 82 && state.care > 74) return "smug";
  return "content";
}

function loadState(): PetState {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...defaultState, lastVisit: Date.now() };

    const parsed = JSON.parse(saved) as PetState;
    const hoursAway = Math.max(0, (Date.now() - parsed.lastVisit) / 36e5);
    const mined = Math.min(48, Math.floor(hoursAway * 1));
    const isNewCareDay = parsed.lastCareDay !== todayKey();
    const isNewTapDay = (parsed.lastTapDay ?? "") !== todayKey();

    // Bond decay: measured from the last actual tap, not from app visits, since
    // Bond is specifically about the affection/tap loop, not general app usage.
    const lastTapAt = parsed.lastTapAt ?? parsed.lastVisit ?? Date.now();
    const hoursSinceTap = Math.max(0, (Date.now() - lastTapAt) / 36e5);
    const hoursPastGrace = Math.max(0, hoursSinceTap - BOND_DECAY_GRACE_HOURS);
    const bondAfterDecay = clamp(
      (typeof parsed.bond === "number" && !Number.isNaN(parsed.bond) ? parsed.bond : defaultState.bond) -
        hoursPastGrace * BOND_DECAY_PER_HOUR,
    );

    return {
      ...defaultState,
      ...parsed,
      bond: bondAfterDecay,
      glimmer: parsed.glimmer + mined,
      hunger: clamp(parsed.hunger - hoursAway * 3),
      happiness: clamp(parsed.happiness - hoursAway * 1.4),
      energy: clamp(parsed.energy + hoursAway * 5),
      care: clamp(parsed.care - hoursAway * 1.8),
      lastVisit: Date.now(),
      // Daily caps reset on a new calendar day, not on a timer - simple and predictable.
      actionsToday: isNewCareDay
        ? { feed: 0, play: 0, groom: 0, nap: 0 }
        : { ...defaultState.actionsToday, ...parsed.actionsToday },
      // Tap-day tracking is fully independent from care-button day tracking.
      tapsToday: isNewTapDay ? 0 : parsed.tapsToday ?? 0,
      // Old saves won't have this field — fall back to empty so equip/unlock
      // logic never crashes on undefined.
      accessories: parsed.accessories ?? createEmptyAccessoryState(),
    };
  } catch {
    return { ...defaultState, lastVisit: Date.now() };
  }
}

// Same decay logic as loadState() but takes a saved PetState directly
// instead of reading from localStorage — used when loading from the DB.
function loadStateFromSaved(parsed: PetState): PetState {
  const hoursAway = Math.max(0, (Date.now() - parsed.lastVisit) / 36e5);
  const mined = Math.min(48, Math.floor(hoursAway * 1));
  const isNewCareDay = parsed.lastCareDay !== todayKey();
  const isNewTapDay = (parsed.lastTapDay ?? "") !== todayKey();

  const lastTapAt = parsed.lastTapAt ?? parsed.lastVisit ?? Date.now();
  const hoursSinceTap = Math.max(0, (Date.now() - lastTapAt) / 36e5);
  const hoursPastGrace = Math.max(0, hoursSinceTap - BOND_DECAY_GRACE_HOURS);
  const bondAfterDecay = clamp(
    (typeof parsed.bond === "number" && !Number.isNaN(parsed.bond)
      ? parsed.bond
      : defaultState.bond) - hoursPastGrace * BOND_DECAY_PER_HOUR,
  );

  return {
    ...defaultState,
    ...parsed,
    bond: bondAfterDecay,
    glimmer: parsed.glimmer + mined,
    hunger: clamp(parsed.hunger - hoursAway * 3),
    happiness: clamp(parsed.happiness - hoursAway * 1.4),
    energy: clamp(parsed.energy + hoursAway * 5),
    care: clamp(parsed.care - hoursAway * 1.8),
    lastVisit: Date.now(),
    actionsToday: isNewCareDay
      ? { feed: 0, play: 0, groom: 0, nap: 0 }
      : { ...defaultState.actionsToday, ...parsed.actionsToday },
    tapsToday: isNewTapDay ? 0 : parsed.tapsToday ?? 0,
    accessories: parsed.accessories ?? createEmptyAccessoryState(),
  };
}

let floatId = 0;

export default function ClientPage() {
  // Server and first client render both use defaultState - no mismatch possible.
  const [state, setState] = useState<PetState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [fid, setFid] = useState<number | null>(null);
  const [lastAction, setLastAction] = useState("You found a tiny white kitty.");
  const [carePulse, setCarePulse] = useState<ActionType | "">("");
  const [poked, setPoked] = useState(false);
  const [floats, setFloats] = useState<FloatingNumber[]>([]);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const kittyRef = useRef<HTMLDivElement>(null);

  // Load state from DB using FID — falls back to localStorage if API fails or no FID yet.
  useEffect(() => {
    if (fid === null) return; // wait until FID is known from SDK context
    fetch(`/api/pet?fid=${fid}`)
      .then((r) => r.json())
      .then((saved) => {
        if (!saved) {
          setState({ ...defaultState, lastVisit: Date.now() });
        } else {
          setState(loadStateFromSaved(saved));
        }
        setHydrated(true);
      })
      .catch(() => {
        // API failed — fall back to localStorage so app still works
        setState(loadState());
        setHydrated(true);
      });
  }, [fid]);

  useEffect(() => {
    // Timeout fallback — if SDK doesn't respond in 2s (e.g. plain browser), load from localStorage
    const fallbackTimer = setTimeout(() => {
      if (!hydrated) {
        setState(loadState());
        setHydrated(true);
      }
    }, 2000);

    sdk.actions.ready().catch(() => {
      clearTimeout(fallbackTimer);
      setState(loadState());
      setHydrated(true);
    });

    sdk.context
      .then((ctx) => {
        if (ctx?.user?.fid) {
          setFid(ctx.user.fid);
          // Check for referral link ?ref=<FID> and register if present
          const refParam = new URL(window.location.href).searchParams.get("ref");
          if (refParam && String(ctx.user.fid) !== refParam) {
            fetch("/api/referral/register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                newUserFID: ctx.user.fid,
                referrerFID: parseInt(refParam),
              }),
            })
              .then((r) => r.json())
              .then((data) => {
                // Server only sends isNewJoiner:true the first time this FID
                // is ever registered — safe even if localStorage gets cleared.
                if (data?.isNewJoiner) {
                  setState((cur) => ({ ...cur, xp: cur.xp + 20 }));
                  showActionBubble("+20 XP — Welcome new member! 🎉");
                }
              })
              .catch(() => {}); // fire and forget — never block app load on this
          }
        }
      })
      .catch(() => {});

    return () => clearTimeout(fallbackTimer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    // Always keep localStorage as offline fallback
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    // Save to DB if we have a FID — debounced 800ms to avoid hammering on rapid taps
    if (!fid) return;
    const timer = setTimeout(() => {
      fetch("/api/pet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid, state }),
      }).catch(() => {}); // silent fail — localStorage already has it
    }, 800);
    return () => clearTimeout(timer);
  }, [state, hydrated, fid]);

  const mood = useMemo(() => moodFor(state), [state]);
  const stage = getStage(state.xp);
  const stageIndex = stages.findIndex((item) => item.name === stage.name) + 1;
  const nextStage = getNextStage(state.xp);
  const progress = nextStage
    ? Math.min(100, ((state.xp - stage.minXp) / (nextStage.minXp - stage.minXp)) * 100)
    : 100;
  const growth = Math.min(
    100,
    Math.round(state.xp / 8 + state.care * 0.24 + state.happiness * 0.16 + state.streak * 3),
  );
  const bondDisplay = clamp(state.bond);
  const bondBonusPct = bondXpBonusPct(state.bond);
  const hoursSinceLastTap = (Date.now() - state.lastTapAt) / 36e5;
  const bondIsDecaying = hoursSinceLastTap > BOND_DECAY_GRACE_HOURS && state.bond > 0;
  const tapsLeftToday = Math.max(
    0,
    BOND_TAP_DAILY_CAP - ((state.lastTapDay ?? "") !== todayKey() ? 0 : state.tapsToday),
  );
  const [showFaq, setShowFaq] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [closetOpen, setClosetOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [referralData, setReferralData] = useState<{
    referralLink: string;
    friends: { fid: number; checkins: number; status: string; username: string; pfp: string }[];
    totalEarned: number;
  } | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [closetMessage, setClosetMessage] = useState<string | null>(null);
  const [closetStageView, setClosetStageView] = useState<number>(stageIndex);
  const [unlockPending, setUnlockPending] = useState<string | null>(null); // accessory id being unlocked
  const lastActionHasBonus = lastAction.includes("bond bonus");
  const checkedInToday = state.lastCheckInDay === todayKey();

  // ── Daily Event ───────────────────────────────────────────────────────────
  type DailyEvent = {
    id: string;
    emoji: string;
    title: string;
    message: string;
    effect: Partial<Record<string, number>>;
  };
  const [todayEvent, setTodayEvent] = useState<DailyEvent | null>(null);
  const [eventVisible, setEventVisible] = useState(false);
  const [eventDismissing, setEventDismissing] = useState(false);

  function dismissEvent() {
    setEventDismissing(true);
    setTimeout(() => setEventVisible(false), 600); // matches animation duration
  }

  useEffect(() => {
    if (!hydrated) return;
    if (state.lastEventDay === todayKey()) return;

    fetch("/api/event")
      .then((r) => r.json())
      .then(({ event }: { event: DailyEvent }) => {
        if (!event) return;
        setTodayEvent(event);
        // Only show banner and apply effects if user has checked in today
        if (state.lastCheckInDay === todayKey()) {
          setEventVisible(true);
          setEventDismissing(false);
          setTimeout(() => dismissEvent(), 5000);
          setState((cur) => {
            const fx = event.effect ?? {};
            return {
              ...cur,
              lastEventDay: todayKey(),
              glimmer: fx.glimmer ? clamp(cur.glimmer + fx.glimmer) : cur.glimmer,
              xp: fx.xp ? cur.xp + fx.xp : cur.xp,
              energy: fx.energy ? clamp(cur.energy + fx.energy) : cur.energy,
              hunger: fx.hunger ? clamp(cur.hunger + fx.hunger) : cur.hunger,
              happiness: fx.happiness ? clamp(cur.happiness + fx.happiness) : cur.happiness,
              care: fx.care ? clamp(cur.care + fx.care) : cur.care,
              bond: fx.bond ? clamp(cur.bond + fx.bond) : cur.bond,
            };
          });
        }
      })
      .catch(() => {});
  }, [hydrated, state.lastCheckInDay]);

  // Keep closet default view in sync with cat's current stage (e.g. on evolution)
  useEffect(() => {
    setClosetStageView(stageIndex);
  }, [stageIndex]);

  // Action bubble — shows near buttons after each care action, fades after 2.5s
  const [actionBubble, setActionBubble] = useState<string | null>(null);
  const actionBubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showActionBubble(msg: string) {
    if (actionBubbleTimer.current) clearTimeout(actionBubbleTimer.current);
    setActionBubble(msg);
    actionBubbleTimer.current = setTimeout(() => setActionBubble(null), 2500);
  }

  // ── Check-in payment state ────────────────────────────────────────────────
  const FREE_CHECKIN_DAYS = 5;
  const CHECKIN_USD = 0.01; // $0.01 per check-in after the free period
  const RECIPIENT = "0xCF8A44059652DB5Af8B4CB62938c5DC6916eB082" as const;

  const totalCheckIns = state.totalCheckIns ?? 0;
  const freeCheckInsLeft = Math.max(0, FREE_CHECKIN_DAYS - totalCheckIns);
  const isFreeCheckin = freeCheckInsLeft > 0;

  const [checkinPending, setCheckinPending] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);

  // ── USDC contract payment ─────────────────────────────────────────────────
  // USDC on Base mainnet
  const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

  // Encode ERC-20 transfer(address,uint256) calldata
  // transfer selector = 0xa9059cbb
  // recipient and amount are ABI-encoded as 32-byte padded hex
  function encodeUsdcTransfer(toAddress: string, usdAmount: number): string {
    const selector = "a9059cbb";
    const microUsdc = Math.round(usdAmount * 1_000_000);
    // strip 0x if present, left-pad to 32 bytes (64 hex chars)
    const paddedTo = toAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const paddedAmount = microUsdc.toString(16).padStart(64, "0");
    return "0x" + selector + paddedTo + paddedAmount;
  }

  // Sends exact USDC via direct contract call — no editable form, exact amount only.
  // Waits for on-chain confirmation and verifies success before resolving.
  // Throws if the wallet rejects, if the tx fails to confirm in time, or if
  // it confirms but REVERTED (e.g. insufficient balance) — callers must not
  // treat a returned txHash alone as proof of payment.
  async function sendUsdcPayment(usdAmount: number): Promise<string> {
    const provider = await sdk.wallet.getEthereumProvider();
    if (!provider) throw new Error("No wallet connected.");
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts || accounts.length === 0) throw new Error("No wallet connected.");

    const data = encodeUsdcTransfer(RECIPIENT, usdAmount);
    const txHash: string = await provider.request({
      method: "eth_sendTransaction",
      params: [{
        from: accounts[0] as `0x${string}`,
        to: USDC_CONTRACT,
        data: data as `0x${string}`,
      }],
    });

    // Submission alone is NOT proof of payment — poll until the tx is mined
    // and confirm it didn't revert. Base blocks are fast; ~2s polling with a
    // generous timeout comfortably covers normal confirmation times.
    const receipt = await waitForUsdcReceipt(provider, txHash);

    // status is "0x1" for success, "0x0" for a reverted (failed) transaction.
    if (!receipt || receipt.status !== "0x1") {
      throw new Error("Payment did not complete on-chain. No funds were taken — please try again.");
    }

    return txHash;
  }

  // Polls eth_getTransactionReceipt until the transaction is mined or the
  // timeout elapses. Returns null if it never confirms in time (treated as
  // a failure by the caller — safer than assuming success).
  async function waitForUsdcReceipt(
    provider: any,
    txHash: string,
    timeoutMs: number = 60_000,
    pollIntervalMs: number = 2_000
  ): Promise<{ status: string } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const receipt = await provider.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (receipt && receipt.status) {
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return null; // never confirmed within timeout
  }

  // yesterday's date key
  function yesterdayKey() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  const checkinStreak = state.checkinStreak ?? 0;
  const missedYesterday = !checkedInToday && state.lastCheckInDay !== "" && state.lastCheckInDay !== yesterdayKey() && state.lastCheckInDay !== todayKey();
  const streakRewardEarned = checkinStreak > 0 && checkinStreak % 7 === 0;

  // Applies check-in to state after payment confirmed (or for free days)
  function applyCheckIn() {
    setState((current) => {
      const isNewDay = current.lastCheckInDay !== todayKey();
      if (!isNewDay) return current;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yKey = yesterday.toISOString().slice(0, 10);
      const consecutive = current.lastCheckInDay === yKey;
      const newCheckinStreak = consecutive ? (current.checkinStreak ?? 0) + 1 : 1;
      const streakBonus = newCheckinStreak % 7 === 0 ? 5 : 0;
      const history = [...(current.checkinHistory ?? []), todayKey()].slice(-7);
      return {
        ...current,
        lastCheckInDay: todayKey(),
        streak: current.streak + 1,
        checkinStreak: newCheckinStreak,
        xp: current.xp + streakBonus,
        checkinHistory: history,
        totalCheckIns: (current.totalCheckIns ?? 0) + 1,
        actionsToday: { feed: 0, play: 0, groom: 0, nap: 0 },
      };
    });
    const isSeventhDay = (state.checkinStreak + 1) % 7 === 0;
    setLastAction(isSeventhDay
      ? "7-day streak! +5 XP bonus dropped. Keep it going!"
      : "Day started! Care for Grub to earn XP and keep your streak.");

    // Notify referral system — fire and forget, non-blocking
    if (fid) {
      fetch("/api/referral/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userFID: fid }),
      }).catch(() => {});
    }
  }

  async function doCheckIn() {
    if (checkedInToday || checkinPending) return;
    setCheckinError(null);

    // Free check-in (first 5 days) — no payment needed
    if (isFreeCheckin) {
      applyCheckIn();
      setLastAction(
        freeCheckInsLeft === 1
          ? `Day started! Last free check-in used. Tomorrow costs $0.01.`
          : `Day started! ${freeCheckInsLeft - 1} free check-in${freeCheckInsLeft - 1 === 1 ? "" : "s"} remaining.`,
      );
      return;
    }

    // Paid check-in — exact $0.01 USDC on Base via contract call
    setCheckinPending(true);
    try {
      await sendUsdcPayment(CHECKIN_USD);
      applyCheckIn();
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("cancel")) {
        setCheckinError("Cancelled. Tap Check In to try again.");
      } else if (msg.toLowerCase().includes("wallet") || msg.toLowerCase().includes("connect") || msg.toLowerCase().includes("account")) {
        setCheckinError("No wallet connected. Open in Farcaster to pay.");
      } else {
        setCheckinError(`Payment failed: ${msg.slice(0, 80)}`);
      }
    } finally {
      setCheckinPending(false);
    }
  }
  const line = useMemo(() => {
    const pool = dialogue[mood];
    return pool[Math.floor((state.xp + state.glimmer + state.hunger) % pool.length)];
  }, [mood, state.glimmer, state.hunger, state.xp]);

  function spawnFloat(text: string, pos?: { x: number; y: number }) {
    const rect = kittyRef.current?.getBoundingClientRect();
    const x = pos?.x ?? (rect ? rect.width / 2 + (Math.random() * 60 - 30) : 0);
    const y = pos?.y ?? (rect ? rect.height * 0.3 : 0);
    const id = floatId++;
    setFloats((current) => [...current, { id, text, x, y }]);
    window.setTimeout(() => {
      setFloats((current) => current.filter((f) => f.id !== id));
    }, 1100);
  }

  const FEED_GLIMMER_COST = 8;

  function doCare(action: ActionType) {
    const usedToday = state.actionsToday[action] ?? 0;
    const limit = dailyLimits[action];

    if (usedToday >= limit) {
      const labels: Record<ActionType, string> = {
        feed: "fed",
        play: "played with",
        groom: "groomed",
        nap: "napped",
      };
      setLastAction(`Already ${labels[action]} enough for today. Come back tomorrow.`);
      return;
    }

    if (action === "feed" && state.glimmer < FEED_GLIMMER_COST) {
      setLastAction("Not enough glimmer to feed. It builds up while you're away - come back later.");
      return;
    }

    setCarePulse(action);
    window.setTimeout(() => setCarePulse(""), 620);
    sdk.haptics.selectionChanged().catch(() => {});

    // Compute labels outside setState to avoid double-fire in React Strict Mode
    const baseXp = xpPerAction[action];
    const bonusPct = bondXpBonusPct(state.bond);
    const xpLabel = `+${baseXp} xp`;
    const bonusNote = bonusPct > 0 ? ` (+${bonusPct}% bond bonus)` : "";

    if (action === "feed") {
      setLastAction(`Fed with warm moonmilk. Tiny trust increased.${bonusNote}`);
      showActionBubble(`🍼 Fed! ${xpLabel}${bonusNote}`);
      spawnFloat(xpLabel);
    } else if (action === "play") {
      setLastAction(`Played softly. The floof remembered joy.${bonusNote}`);
      showActionBubble(`🎀 Played! ${xpLabel}${bonusNote}`);
      spawnFloat(xpLabel);
    } else if (action === "groom") {
      setLastAction(`Brushed into cloud status. Extremely precious.${bonusNote}`);
      showActionBubble(`✨ Groomed! ${xpLabel}${bonusNote}`);
      spawnFloat(xpLabel);
    } else if (action === "nap") {
      setLastAction(`Nap complete. Purr engine recalibrated.${bonusNote}`);
      showActionBubble(`💤 Napped! ${xpLabel}${bonusNote}`);
      spawnFloat(xpLabel);
    }

    setState((current) => {
      const isNewCareDay = current.lastCareDay !== todayKey();
      const next: PetState = {
        ...current,
        lastVisit: Date.now(),
        lastCareDay: todayKey(),
        // streak is managed by applyCheckIn only — do NOT increment here
        // to avoid double-counting (check-in + first care action both firing on same day)
        actionsToday: {
          ...current.actionsToday,
          [action]: (current.actionsToday[action] ?? 0) + 1,
        },
      };

      const exactXp = xpPerAction[action] * bondXpMultiplier(current.bond);

      if (action === "feed") {
        next.hunger = clamp(current.hunger + 28);
        next.happiness = clamp(current.happiness + 9);
        next.energy = clamp(current.energy + 5);
        next.care = clamp(current.care + 12);
        next.xp = current.xp + exactXp;
        next.glimmer = Math.max(0, current.glimmer - FEED_GLIMMER_COST);
      } else if (action === "play") {
        next.happiness = clamp(current.happiness + 24);
        next.energy = clamp(current.energy - 12);
        next.hunger = clamp(current.hunger - 8);
        next.care = clamp(current.care + 7);
        next.xp = current.xp + exactXp;
      } else if (action === "groom") {
        next.care = clamp(current.care + 26);
        next.happiness = clamp(current.happiness + 12);
        next.energy = clamp(current.energy + 2);
        next.xp = current.xp + exactXp;
      } else if (action === "nap") {
        next.energy = clamp(current.energy + 34);
        next.hunger = clamp(current.hunger - 5);
        next.happiness = clamp(current.happiness + 4);
        next.xp = current.xp + exactXp;
      }

      return next;
    });
  }

  // Direct tap on the cat itself - separate from the action buttons.
  // Small chance of a bonus, mostly just a reaction + dialogue line, so taps stay rewarding.
  // Takes the actual click position so feedback lands exactly where the finger touched.
  function pokeKitty(point?: { x: number; y: number }) {
    setPoked(true);
    window.setTimeout(() => setPoked(false), 420);
    sdk.haptics.selectionChanged().catch(() => {});

    if (point) {
      const rippleId = floatId++;
      setRipples((current) => [...current, { id: rippleId, x: point.x, y: point.y }]);
      window.setTimeout(() => {
        setRipples((current) => current.filter((r) => r.id !== rippleId));
      }, 500);
    }

    const moodPool = pokeLines[mood];
    const milestonePool = unlockedMilestoneLines(state.bond);
    // Milestone lines are mixed in at roughly 1-in-3 odds once unlocked, so they feel
    // like a special surprise rather than replacing the mood-based reactions entirely.
    const useMilestoneLine = milestonePool.length > 0 && Math.random() < 0.33;
    const pool = useMilestoneLine ? milestonePool : moodPool;
    const reaction = pool[Math.floor(Math.random() * pool.length)];
    setLastAction(reaction);
    spawnFloat("♥", point);

    setState((current) => {
      const isNewTapDay = (current.lastTapDay ?? "") !== todayKey();
      const tapsToday = isNewTapDay ? 0 : current.tapsToday;

      if (tapsToday >= BOND_TAP_DAILY_CAP) {
        // Past the soft cap: still affectionate (heart already shown above), no more Bond,
        // but lastTapAt still updates - you showed up and interacted, so decay timer resets.
        return { ...current, lastTapDay: todayKey(), lastTapAt: Date.now(), tapsToday };
      }

      return {
        ...current,
        bond: clamp(current.bond + BOND_PER_TAP),
        lastTapDay: todayKey(),
        lastTapAt: Date.now(),
        tapsToday: tapsToday + 1,
      };
    });
  }

  function shareKitty() {
    sdk.actions
      .composeCast({
        text: `My Grub is ${stage.name} with ${state.streak} care day streak. This tiny white kitty is emotionally expensive.`,
      })
      .catch(() => {
        setLastAction("Sharing works inside Farcaster. Local test mode is fine.");
      });
  }

  // Accessory unlock cost — stage-aware pricing on Base
  function accessoryUnlockUsd(accessoryId: string): number {
    const acc = ACCESSORIES.find((a) => a.id === accessoryId);
    return acc?.costUsd ?? 0.10;
  }

  async function handleUnlockAccessory(accessoryId: string) {
    if (unlockPending) return; // prevent double-tap

    // Guard: already unlocked
    if (isUnlocked(state.accessories, accessoryId)) {
      setClosetMessage("Already unlocked.");
      return;
    }

    setUnlockPending(accessoryId);
    setClosetMessage(null);

    const price = accessoryUnlockUsd(accessoryId);

    try {
      await sendUsdcPayment(price);
      const unlockResult = unlockAccessory(state.accessories, accessoryId);
      if (unlockResult.ok === true) {
        setState((prev) => ({ ...prev, accessories: unlockResult.newState }));
        setClosetMessage(null);
        setLastAction("New accessory unlocked! Tap Equip to dress up Grub.");
      } else {
        setClosetMessage(unlockResult.reason);
      }
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("cancel")) {
        setClosetMessage("Cancelled. Tap Unlock to try again.");
      } else if (msg.toLowerCase().includes("wallet") || msg.toLowerCase().includes("connect") || msg.toLowerCase().includes("account")) {
        setClosetMessage("No wallet connected. Open in Farcaster to pay.");
      } else if (msg.toLowerCase().includes("did not complete") || msg.toLowerCase().includes("revert")) {
        setClosetMessage("Payment didn't go through on-chain. No funds were taken — check your USDC balance and try again.");
      } else {
        setClosetMessage(`Payment failed: ${msg.slice(0, 80)}`);
      }
    } finally {
      setUnlockPending(null);
    }
  }

  function handleEquipAccessory(accessoryId: string) {
    const result = equipAccessory(state.accessories, accessoryId, stageIndex);
    if (result.ok === true) {
      setState((prev) => ({ ...prev, accessories: result.newState }));
      setClosetMessage(null);
    } else {
      setClosetMessage(result.reason);
    }
  }

  function handleRemoveAccessory(slot: AccessorySlot) {
    setState((prev) => ({ ...prev, accessories: removeAccessory(prev.accessories, slot) }));
    setClosetMessage(null);
  }

  if (!hydrated) return (
    <main className="app-shell" style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minHeight: "100dvh" }}>
      <img src="/cats/stage1.webp" alt="Grub loading" style={{ width: 80, opacity: 0.55 }} />
      <p style={{ color: "#b5a49a", fontSize: "0.8rem", marginTop: 12, fontWeight: 600 }}>Loading Grub...</p>
    </main>
  );

  return (
    <main className={`app-shell mood-${mood}`}>
      <section className="phone-frame">
        <header className="topbar">
          <div>
            <h1>Grub</h1>
          </div>
          <button className="ghost-button" type="button" onClick={() => setShowFaq(true)}>
            ?
          </button>
        </header>

        {/* ── CAT SECTION ── */}
        <section className="hero">
          <div className="stage-copy">
            <div className="stage-oneline">
              <span className="stage-title-pill">{stage.title}</span>
              <span className="stage-name-inline">{stage.name}</span>
            </div>
            <p className="stage-note-text">{stage.note}</p>
          </div>

          <div className="kitty-stage-wrap" ref={kittyRef}>
            <Kitty
              stage={stageIndex}
              mood={mood}
              growth={growth}
              carePulse={carePulse}
              poked={poked}
              onPoke={pokeKitty}
              equippedAccessoryIds={getEquippedForStage(state.accessories, stageIndex)}
            />
            {ripples.map((r) => (
              <span key={r.id} className="tap-ripple" style={{ left: r.x, top: r.y }} />
            ))}
            {floats.map((f) => (
              <span key={f.id} className="floating-number" style={{ left: f.x, top: f.y }}>
                {f.text}
              </span>
            ))}
          </div>

          <div className="world-label">
            <span>{stage.world}</span>
            <strong>{growth}% grown</strong>
          </div>
        </section>

        {/* ── DAILY EVENT BANNER ── */}
        {eventVisible && todayEvent && (
          <div
            onClick={dismissEvent}
            style={{
              margin: "0 0 10px 0",
              padding: "10px 14px",
              background: "rgba(255,255,255,0.72)",
              border: "1.5px solid rgba(43,33,29,0.13)",
              borderRadius: 14,
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              position: "relative",
              cursor: "pointer",
              animation: eventDismissing
                ? "eventBubblePop 0.6s cubic-bezier(.4,1.4,.6,1) forwards"
                : "eventBubbleIn 0.5s cubic-bezier(.4,1.4,.6,1) both",
            }}>
            <span style={{ fontSize: "1.6rem", lineHeight: 1 }}>{todayEvent.emoji}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: "0.82rem", color: "#49332d", marginBottom: 2 }}>
                {todayEvent.title}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#7a5c4f", lineHeight: 1.4 }}>
                {todayEvent.message}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#4caf7d", fontWeight: 700, marginTop: 4 }}>
                {Object.entries(todayEvent.effect ?? {})
                  .filter(([, v]) => v !== 0)
                  .map(([k, v]) => `${(v as number) > 0 ? "+" : ""}${v} ${k}`)
                  .join(" · ")}
              </div>
            </div>
          </div>
        )}

        {/* ── SPEECH ── */}
        <section className="speech">
          <p>{line}</p>
          <span className={lastActionHasBonus ? "has-bonus" : ""}>{lastAction}</span>
        </section>

        {/* ── CARE BUTTONS — right under cat ── */}
        <section className="actions-wrap" aria-label="Care actions">

          {/* Action bubble result */}
          {actionBubble && (
            <div style={{
              background: "rgba(255,255,255,0.96)",
              border: "1.5px solid rgba(43,33,29,0.13)",
              borderRadius: 16,
              padding: "8px 18px",
              marginBottom: 8,
              textAlign: "center",
              fontSize: "0.88rem",
              fontWeight: 700,
              color: "#49332d",
              boxShadow: "0 4px 18px rgba(43,33,29,0.10)",
              animation: "bubblePop 0.22s cubic-bezier(.4,1.6,.6,1) both",
            }}>
              {actionBubble}
            </div>
          )}

          {/* 4 care buttons — always visible, locked if not checked in */}
          <div className={`actions${!checkedInToday ? " actions-locked" : ""}`}>
            <button
              type="button"
              onClick={() => doCare("feed")}
              disabled={!checkedInToday || state.actionsToday.feed >= dailyLimits.feed || state.glimmer < FEED_GLIMMER_COST}
            >
              <span>Feed</span>
              <small>
                {!checkedInToday
                  ? "check in first"
                  : state.actionsToday.feed >= dailyLimits.feed
                    ? "0 left today"
                    : state.glimmer < FEED_GLIMMER_COST
                      ? "need glimmer"
                      : `${dailyLimits.feed - state.actionsToday.feed} left today`}
              </small>
            </button>
            <button
              type="button"
              onClick={() => doCare("play")}
              disabled={!checkedInToday || state.actionsToday.play >= dailyLimits.play}
            >
              <span>Play</span>
              <small>{!checkedInToday ? "check in first" : `${Math.max(0, dailyLimits.play - state.actionsToday.play)} left today`}</small>
            </button>
            <button
              type="button"
              onClick={() => doCare("groom")}
              disabled={!checkedInToday || state.actionsToday.groom >= dailyLimits.groom}
            >
              <span>Groom</span>
              <small>{!checkedInToday ? "check in first" : `${Math.max(0, dailyLimits.groom - state.actionsToday.groom)} left today`}</small>
            </button>
            <button
              type="button"
              onClick={() => doCare("nap")}
              disabled={!checkedInToday || state.actionsToday.nap >= dailyLimits.nap}
            >
              <span>Nap</span>
              <small>{!checkedInToday ? "check in first" : `${Math.max(0, dailyLimits.nap - state.actionsToday.nap)} left today`}</small>
            </button>
          </div>

          <p className="actions-hint" style={{ color: "#49332d", fontWeight: 700, marginTop: 6 }}>
            Tap Grub anytime to build Bond.
          </p>

          {/* ── CHECK IN — below buttons ── */}
          {!checkedInToday && (
            <div className="checkin-gate">
              {missedYesterday && (
                <p style={{ color: "#b5544f", fontSize: "0.78rem" }}>⚠️ You missed yesterday — streak reset</p>
              )}
              <p>Check in to unlock today's care actions</p>
              <div style={{ display: "flex", gap: 7, justifyContent: "center", alignItems: "center" }}>
                {Array.from({ length: 7 }).map((_, i) => {
                  const dayKey = (() => { const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().slice(0, 10); })();
                  const history = state.checkinHistory ?? [];
                  const firstDay = history[0] ?? todayKey();
                  const hit = history.includes(dayKey);
                  const isPast = dayKey < todayKey() && dayKey >= firstDay;
                  const missed = isPast && !hit;
                  return (
                    <span key={i} title={dayKey} style={{
                      width: 13, height: 13, borderRadius: "50%",
                      background: hit ? "#4caf7d" : missed ? "#c0392b" : "rgba(43,33,29,0.22)",
                      display: "inline-block",
                      boxShadow: hit ? "0 2px 6px rgba(76,175,125,0.45)" : missed ? "0 2px 6px rgba(192,57,43,0.35)" : "none",
                    }} />
                  );
                })}
              </div>
              <small>{checkinStreak % 7 === 0 && checkinStreak > 0
                ? "🎉 7-day streak — +5 XP bonus on check-in!"
                : checkinStreak === 0
                ? "Start your streak → +5 XP bonus on day 7"
                : `${checkinStreak % 7}/7 days — keep going for +5 XP bonus`}
              </small>
              <button type="button" className="checkin-btn" onClick={doCheckIn} disabled={checkinPending}>
                {checkinPending
                  ? "⏳ Confirming..."
                  : streakRewardEarned
                  ? "✦ Check In · +5 XP bonus!"
                  : isFreeCheckin
                  ? `✦ Check In · Free (${freeCheckInsLeft} left)`
                  : "✦ Check In · $0.01"}
              </button>
              {checkinError && (
                <small style={{ color: "#b5544f", fontSize: "0.78rem", marginTop: 2 }}>
                  {checkinError}
                </small>
              )}
              <small>
                {isFreeCheckin
                  ? `First 5 days free · then $0.01/day on Base`
                  : "Wallet payment on Base"}
              </small>
            </div>
          )}

          {/* Streak dots when checked in */}
          {checkedInToday && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 8, marginBottom: 16 }}>
              <small style={{ color: "#49332d", fontSize: "0.75rem", fontWeight: 800 }}>
                {checkinStreak === 0
                  ? "Start your streak → +5 XP bonus on day 7"
                  : checkinStreak % 7 === 0
                  ? "🎉 7-day streak — +5 XP bonus earned!"
                  : `${checkinStreak % 7}/7 days — keep going for +5 XP bonus`}
              </small>
              <div style={{ display: "flex", gap: 7 }}>
                {Array.from({ length: 7 }).map((_, i) => {
                  const dayKey = (() => { const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().slice(0, 10); })();
                  const history = state.checkinHistory ?? [];
                  const firstDay = history[0] ?? todayKey();
                  const hit = history.includes(dayKey);
                  const isPast = dayKey < todayKey() && dayKey >= firstDay;
                  const missed = isPast && !hit;
                  return (
                    <span key={i} title={dayKey} style={{
                      width: 14, height: 14, borderRadius: "50%",
                      background: hit ? "#4caf7d" : missed ? "#c0392b" : "rgba(43,33,29,0.22)",
                      display: "inline-block",
                      boxShadow: hit ? "0 2px 6px rgba(76,175,125,0.45)" : missed ? "0 2px 6px rgba(192,57,43,0.35)" : "none",
                    }} />
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* ── STATS COLLAPSIBLE ── */}
        <section className="stats-collapsible" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="stats-toggle"
            onClick={() => setStatsOpen((o) => !o)}
          >
            <span>📊 Stats</span>
            <span className="stats-chevron">{statsOpen ? "▲" : "▼"}</span>
          </button>

          {statsOpen && (
            <div className="stats-body">
              <section className="resource-row" aria-label="Kitty progress">
                <div>
                  <span>Glimmer</span>
                  <strong>{state.glimmer}</strong>
                </div>
                <div>
                  <span>Streak</span>
                  <strong>{state.streak}d</strong>
                </div>
                <div>
                  <span>Bond</span>
                  <strong>{bondDisplay}%</strong>
                  <small className={`resource-subtext ${bondIsDecaying ? "is-warning" : ""}`}>
                    {bondIsDecaying
                      ? "fading - pat Grub soon"
                      : `+${bondBonusPct}% xp · ${tapsLeftToday} pats left`}
                  </small>
                </div>
              </section>

              <section className="stats-grid">
                <Stat label="Hunger" value={state.hunger} />
                <Stat label="Joy" value={state.happiness} />
                <Stat label="Energy" value={state.energy} />
                <Stat label="Care" value={state.care} />
              </section>

              <section className="evolution">
                <div>
                  <span>Evolution</span>
                  <strong>
                    {nextStage
                      ? `${Math.floor(state.xp)}/${nextStage.minXp} XP`
                      : `${Math.floor(state.xp)} XP`}
                  </strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="life-track" aria-label="Life stages">
                  {stages.map((item, index) => (
                    <span key={item.name} className={index + 1 <= stageIndex ? "is-unlocked" : ""}>
                      {item.title}
                    </span>
                  ))}
                </div>
              </section>
            </div>
          )}
        </section>

        {/* ── CLOSET ── */}
        <section className="closet-collapsible" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="closet-toggle stats-toggle"
            onClick={() => setClosetOpen((o) => !o)}
          >
            <span>👒 Closet</span>
            <span className="stats-chevron">{closetOpen ? "▲" : "▼"}</span>
          </button>

          {closetOpen && (
            <div className="closet-body stats-body">

              {/* ── Stage dropdown ── */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <label
                  htmlFor="closet-stage-select"
                  style={{ fontSize: "0.72rem", color: "#8a7a70", fontWeight: 700, whiteSpace: "nowrap" }}
                >
                  Viewing:
                </label>
                <select
                  id="closet-stage-select"
                  value={closetStageView}
                  onChange={(e) => {
                    setClosetStageView(Number(e.target.value));
                    setClosetMessage(null);
                  }}
                  style={{
                    flex: 1,
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    color: "#2b211d",
                    background: "rgba(255,255,255,0.7)",
                    border: "1.5px solid rgba(43,33,29,0.18)",
                    borderRadius: 8,
                    padding: "4px 8px",
                    cursor: "pointer",
                  }}
                >
                  <option value={1}>Stage 1 — Tiny Cloud</option>
                  <option value={2}>Stage 2 — Pocket Purr</option>
                  <option value={3}>Stage 3 — Pearl Floof</option>
                  <option value={4}>Stage 4 — Moonmilk Mythic</option>
                </select>
              </div>

              {/* Browsing ahead notice */}
              {closetStageView > stageIndex && (
                <p style={{ fontSize: "0.72rem", color: "#8a7a70", textAlign: "center", marginBottom: 6 }}>
                  👀 Browsing ahead — you can buy now, equip when Grub reaches this stage.
                </p>
              )}
              {closetStageView < stageIndex && (
                <p style={{ fontSize: "0.72rem", color: "#8a7a70", textAlign: "center", marginBottom: 6 }}>
                  👀 Stage {closetStageView} items — equip only works when Grub is at this stage.
                </p>
              )}

              {/* Can't equip — right stage but wrong mood */}
              {closetStageView === stageIndex && !accessoriesAllowedFor(stageIndex, mood) && (
                <p style={{ fontSize: "0.78rem", color: "#b5544f", textAlign: "center", marginBottom: 6 }}>
                  Grub needs to be content or happy to wear accessories right now.
                </p>
              )}

              {closetMessage && (
                <p style={{ fontSize: "0.78rem", color: "#b5544f", textAlign: "center", marginBottom: 6 }}>
                  {closetMessage}
                </p>
              )}

              {/* Price hint */}
              <p style={{ fontSize: "0.72rem", color: "#8a7a70", textAlign: "center", marginBottom: 8 }}>
                {closetStageView === 1 && "Stage 1 accessories · $0.10 each on Base"}
                {closetStageView === 2 && "Stage 2 accessories · $0.20 each on Base"}
                {closetStageView === 3 && "Stage 3 accessories · $0.30 each on Base"}
                {closetStageView === 4 && "Stage 4 accessories · $0.40 each on Base"}
              </p>

              {/* Accessory grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 10,
                }}
              >
                {getAccessoriesForStage(closetStageView).length === 0 && (
                  <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "20px 0", color: "#8a7a70", fontSize: "0.78rem" }}>
                    Accessories for this stage coming soon ✨
                  </div>
                )}

                {getAccessoriesForStage(closetStageView).map((accessory) => {
                  const unlocked = isUnlocked(state.accessories, accessory.id);
                  const equipped = isEquipped(state.accessories, accessory.id);
                  const isMyStage = closetStageView === stageIndex;
                  const moodOk = accessoriesAllowedFor(stageIndex, mood);
                  const canEquipNow = isMyStage && moodOk && unlocked && !equipped;

                  return (
                    <div
                      key={accessory.id}
                      style={{
                        border: equipped ? "2px solid #4caf7d" : "1px solid rgba(43,33,29,0.15)",
                        borderRadius: 12,
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 4,
                        background: equipped ? "rgba(76,175,125,0.08)" : "rgba(255,255,255,0.4)",
                      }}
                    >
                      <img
                        src={accessory.imageUrl}
                        alt={accessory.name}
                        style={{ width: 44, height: 44, objectFit: "contain" }}
                      />
                      <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center", lineHeight: 1.2 }}>
                        {accessory.name}
                      </span>
                      <span style={{ fontSize: 9, color: "#8a7a70", textTransform: "capitalize" }}>
                        {accessory.slot}
                      </span>

                      {/* UNLOCK button */}
                      {!unlocked && (
                        <button
                          type="button"
                          onClick={() => handleUnlockAccessory(accessory.id)}
                          disabled={!!unlockPending}
                          style={{
                            fontSize: 10,
                            padding: "3px 8px",
                            borderRadius: 8,
                            border: "none",
                            background: unlockPending === accessory.id ? "#8a7a70" : "#2b211d",
                            color: "white",
                            cursor: unlockPending ? "not-allowed" : "pointer",
                            opacity: unlockPending && unlockPending !== accessory.id ? 0.5 : 1,
                          }}
                        >
                          {unlockPending === accessory.id ? "⏳ Confirming..." : `Unlock · $${accessory.costUsd.toFixed(2)}`}
                        </button>
                      )}

                      {/* EQUIP button */}
                      {unlocked && !equipped && (
                        <button
                          type="button"
                          onClick={() => canEquipNow && handleEquipAccessory(accessory.id)}
                          disabled={!canEquipNow}
                          title={
                            !isMyStage
                              ? `Available when Grub reaches Stage ${accessory.stage}`
                              : !moodOk
                              ? "Grub needs to be content or happy to equip"
                              : undefined
                          }
                          style={{
                            fontSize: 10,
                            padding: "3px 8px",
                            borderRadius: 8,
                            border: "1px solid #2b211d",
                            background: "white",
                            color: canEquipNow ? "#2b211d" : "#8a7a70",
                            cursor: canEquipNow ? "pointer" : "not-allowed",
                            opacity: canEquipNow ? 1 : 0.5,
                          }}
                        >
                          {!isMyStage ? `Stage ${accessory.stage} only` : "Equip"}
                        </button>
                      )}

                      {/* REMOVE button */}
                      {equipped && (
                        <button
                          type="button"
                          onClick={() => handleRemoveAccessory(accessory.slot)}
                          style={{
                            fontSize: 10,
                            padding: "3px 8px",
                            borderRadius: 8,
                            border: "1px solid #b5544f",
                            background: "white",
                            color: "#b5544f",
                            cursor: "pointer",
                          }}
                        >
                          Remove ✓
                        </button>
                      )}

                      {/* Owned badge */}
                      {unlocked && !equipped && (
                        <span style={{ fontSize: 9, color: "#4caf7d", fontWeight: 700 }}>✓ Owned</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* ── REFERRAL ── */}
        <section className="stats-collapsible" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="stats-toggle"
            onClick={async () => {
              const next = !referralOpen;
              setReferralOpen(next);
              if (next && fid && !referralData) {
                setReferralLoading(true);
                try {
                  const res = await fetch(`/api/referral/status?fid=${fid}`);
                  const data = await res.json();
                  if (data.ok) setReferralData(data);
                } catch {}
                setReferralLoading(false);
              }
            }}
          >
            <span>🐾 Referral</span>
            <span className="stats-chevron">{referralOpen ? "▲" : "▼"}</span>
          </button>

          {referralOpen && (
            <div className="stats-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* Referral link box */}
              <div style={{ background: "#f5f0e8", borderRadius: 10, padding: "10px 12px" }}>
                <p style={{ fontSize: 12, color: "#888", margin: "0 0 4px" }}>Your referral link</p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <code style={{ fontSize: 11, flex: 1, wordBreak: "break-all", color: "#444" }}>
                    {fid ? `https://grub-app-eight.vercel.app/?ref=${fid}` : "Loading..."}
                  </code>
                  <button
                    type="button"
                    style={{
                      background: "#1a1a1a", color: "#fff", border: "none",
                      borderRadius: 8, padding: "6px 12px", fontSize: 12,
                      cursor: "pointer", whiteSpace: "nowrap"
                    }}
                    onClick={() => {
                      navigator.clipboard.writeText(`https://grub-app-eight.vercel.app/?ref=${fid}`);
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>

              {/* Share on Farcaster */}
              <button
                type="button"
                style={{
                  background: "#7c3aed", color: "#fff", border: "none",
                  borderRadius: 10, padding: "10px", fontSize: 13,
                  fontWeight: 700, cursor: "pointer", width: "100%"
                }}
                onClick={() => {
                  const refLink = `https://grub-app-eight.vercel.app/?ref=${fid}`;
                  const text = `I'm raising Grub 🐱✨ — a tiny white kitty on Farcaster!\nJoin me and help me earn DEGEN 🎁`;
                  sdk.actions.composeCast({
                    text,
                    embeds: [refLink],
                  }).catch(() => {
                    // fallback
                    sdk.actions.openUrl(
                      `https://warpcast.com/~/compose?text=${encodeURIComponent(text + "\n" + refLink)}`
                    );
                  });
                }}
              >
                🟣 Share on Farcaster
              </button>

              {/* Rewards info */}
              <div style={{ background: "#fff8e7", borderRadius: 10, padding: "10px 12px", fontSize: 12 }}>
                <p style={{ margin: "0 0 4px", fontWeight: 700, color: "#b45309" }}>How it works</p>
                <p style={{ margin: "0 0 2px", color: "#555" }}>🎁 Friend joins → <strong>you</strong> get <strong>1 DEGEN</strong></p>
                <p style={{ margin: 0, color: "#555" }}>🏆 Friend hits 5 check-ins → <strong>you</strong> get <strong>2 DEGEN</strong></p>
              </div>

              {/* Friends list */}
              {referralLoading && (
                <p style={{ textAlign: "center", fontSize: 12, color: "#aaa" }}>Loading...</p>
              )}
              {referralData && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#666" }}>
                    <span>Friends referred: <strong>{referralData.friends.length}</strong></span>
                    <span>Total earned: <strong>{referralData.totalEarned} DEGEN</strong></span>
                  </div>
                  {referralData.friends.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {referralData.friends.map((f) => (
                        <div key={f.fid} style={{
                          background: "#f5f0e8", borderRadius: 8,
                          padding: "8px 12px", display: "flex",
                          justifyContent: "space-between", alignItems: "center", fontSize: 12
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {f.pfp && (
                              <img
                                src={f.pfp}
                                alt=""
                                style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }}
                              />
                            )}
                            <span style={{ color: "#444", fontWeight: 600 }}>@{f.username}</span>
                          </div>
                          <span style={{ color: "#888" }}>{f.checkins}/5 ✓</span>
                          <span style={{
                            color: f.status === "paid" ? "#4caf7d" : "#f59e0b",
                            fontWeight: 700, fontSize: 11
                          }}>
                            {f.status === "paid" ? "✓ Paid" : "⏳ Pending"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {referralData.friends.length === 0 && (
                    <p style={{ textAlign: "center", fontSize: 12, color: "#aaa", margin: 0 }}>
                      No referrals yet — share your link!
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </section>

      </section>
      {showFaq && <FaqModal onClose={() => setShowFaq(false)} />}
    </main>
  );
}

// Maps stage (1-4) + mood to the correct illustrated image file.
// smug ~ happy, hungry/feral ~ angry are close enough substitutes until dedicated art exists.
const moodToImageSuffix: Record<Mood, string> = {
  content: "",
  smug: "",
  hungry: "a",
  feral: "a",
  sleepy: "b",
};

function catImageSrc(stage: number, mood: Mood): string {
  const suffix = moodToImageSuffix[mood];
  return `/cats/stage${stage}${suffix}.webp`;
}

// Per-stage ear configs — Stage 1 coords measured directly from the live page
// using F12 click-mapper (viewBox 168×168, scale ratio ~0.952).
// Left ear:  tip(42,33) base-L(40,61) base-R(52,46)
// Right ear: tip(126,37) base-L(118,52) base-R(126,61)
// Colors pixel-sampled from the actual webp:
//   Left outer:  rgb(196,125,91)  = #c47d5b  (warm brown, matches actual left ear)
//   Left inner:  rgb(214,140,105) = #d68c69  (lighter brown centre)
//   Right outer: rgb(148,96,66)   = #946042  (darker shadow side)
//   Right inner: rgb(220,149,114) = #dc9572  (pink-brown centre)
const earConfig: Record<number, {
  lOuter: string; lInner: string; lPx: number; lPy: number;
  rOuter: string; rInner: string; rPx: number; rPy: number;
  lOuterFill: string; lInnerFill: string;
  rOuterFill: string; rInnerFill: string;
}> = {
  1: {
    lOuter: "M42,37 L40,61 L48,50 Z",
    lInner: "M42,41 L41,56 L47,50 Z",
    lPx: 44, lPy: 58,
    rOuter: "M126,37 L118,52 L126,61 Z",
    rInner: "M126,41 L120,52 L125,57 Z",
    rPx: 122, rPy: 58,
    lOuterFill: "#c47d5b", lInnerFill: "#d68c69",
    rOuterFill: "#946042", rInnerFill: "#dc9572",
  },
  2: {
    lOuter: "M47,37 L45,68 L58,51 Z",
    lInner: "M47,43 L46,63 L55,51 Z",
    lPx: 49, lPy: 65,
    rOuter: "M141,41 L132,58 L141,68 Z",
    rInner: "M141,46 L134,58 L140,64 Z",
    rPx: 137, rPy: 65,
    lOuterFill: "#c47d5b", lInnerFill: "#d68c69",
    rOuterFill: "#946042", rInnerFill: "#dc9572",
  },
  3: {
    lOuter: "M59,23 L53,50 L76,34 Z",
    lInner: "M59,28 L55,45 L72,34 Z",
    lPx: 55, lPy: 47,
    rOuter: "M138,23 L127,33 L142,51 Z",
    rInner: "M138,28 L129,34 L140,46 Z",
    rPx: 132, rPy: 44,
    lOuterFill: "#c47d5b", lInnerFill: "#d68c69",
    rOuterFill: "#946042", rInnerFill: "#dc9572",
  },
  4: {
    lOuter: "M74,19 L69,53 L94,31 Z",
    lInner: "M74,24 L71,48 L90,31 Z",
    lPx: 79, lPy: 34,
    rOuter: "M149,27 L134,37 L146,57 Z",
    rInner: "M149,32 L136,38 L145,52 Z",
    rPx: 145, rPy: 39,
    lOuterFill: "#c47d5b", lInnerFill: "#d68c69",
    rOuterFill: "#946042", rInnerFill: "#dc9572",
  },
};
// Stage 1 image = 168×168px. Eyes are roughly at 38% and 62% across, 52% down.
// Tune lx/ly/rx/ry if eyelids don't land perfectly; rx2/ry2 control ellipse size.
const eyeConfig: Record<number, {
  lx: number; ly: number; rx: number; ry: number;
  rx2: number; ry2: number;
  fill: string;
  size: number; // matches CSS --kitty-size so SVG viewBox is correct
}> = {
  1: { lx: 58,  ly: 86,  rx: 108, ry: 86,  rx2: 17, ry2: 18, fill: "#f5ebe0", size: 168 },
  2: { lx: 65,  ly: 96,  rx: 121, ry: 96,  rx2: 19, ry2: 20, fill: "#f5ebe0", size: 188 },
  3: { lx: 81,  ly: 73,  rx: 116, ry: 72,  rx2: 18, ry2: 16, fill: "#f5ebe0", size: 208 },
  4: { lx: 94,  ly: 64,  rx: 123, ry: 69,  rx2: 9, ry2: 9, fill: "#f5ebe0", size: 232 },
};

function Kitty({
  stage,
  mood,
  growth,
  carePulse,
  poked,
  onPoke,
  equippedAccessoryIds,
}: {
  stage: number;
  mood: Mood;
  growth: number;
  carePulse: ActionType | "";
  poked: boolean;
  onPoke: (point?: { x: number; y: number }) => void;
  equippedAccessoryIds: string[];
}) {
  const growthRatio = growth / 100;
  const src = catImageSrc(stage, mood);
  const eye = eyeConfig[stage] ?? eyeConfig[1];
  const ear = earConfig[stage] ?? earConfig[1];

  // Blink state — idle timer fires every 3–5s, poke also triggers it
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ear wiggle state — set true on poke, cleared after animation
  const [earWiggle, setEarWiggle] = useState(false);

  // Idle blink scheduler
  useEffect(() => {
    function scheduleBlink() {
      blinkTimer.current = setTimeout(() => {
        setBlinking(true);
        setTimeout(() => setBlinking(false), 220);
        scheduleBlink();
      }, 3000 + Math.random() * 2200);
    }
    scheduleBlink();
    return () => {
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
    };
  }, []);

  // Poke triggers both blink and ear wiggle
  useEffect(() => {
    if (poked) {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 220);
      setEarWiggle(true);
      setTimeout(() => setEarWiggle(false), 520);
    }
  }, [poked]);

  return (
    <div
      className={`kitty-wrap kitty-stage-${stage} kitty-mood-${mood} kitty-care-${carePulse || "idle"} ${poked ? "kitty-poked" : ""}`}
      aria-label={`Grub the cat, stage ${stage}, looking ${mood}. Tap to pat.`}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const target = e.currentTarget;
        const localX = e.nativeEvent.offsetX;
        const localY = e.nativeEvent.offsetY;
        onPoke({
          x: target.offsetLeft + localX,
          y: target.offsetTop + localY,
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onPoke();
      }}
      style={{ "--growth-scale": 0.88 + growthRatio * 0.12 } as CSSProperties}
    >
      <div className="kitty-shadow" />

      {/*
        Layered accessory rendering — three passes, back-most to front-most:
        background → behindCat → [cat image] → front. Each accessory carries
        its own `layer` (see lib/accessories.ts), so adding a new one (wings,
        aura, a magic circle, whatever) never means touching this component —
        just tag it with the right layer in the catalog and it slots in.
      */}
      {(() => {
        const showAccessories = accessoriesAllowedFor(stage, mood);
        const layers = showAccessories
          ? groupEquippedByLayer(equippedAccessoryIds)
          : { background: [], behindCat: [], front: [] };

        const renderAccessory = (accessory: Accessory) => {
          const position = getPosition(accessory.id);
          if (!position) return null;
          // Center the accessory on its top/left point first, THEN rotate —
          // order matters: translate(-50%,-50%) has to happen before rotate()
          // or the image spins around its corner instead of its own center.
          const transform = position.rotate
            ? `translate(-50%, -50%) rotate(${position.rotate}deg)`
            : "translate(-50%, -50%)";
          return (
            <img
              key={accessory.id}
              src={accessory.imageUrl}
              alt={accessory.name}
              draggable={false}
              className={`kitty-accessory kitty-accessory-${accessory.layer}`}
              style={{
                position: "absolute",
                top: `${position.top}%`,
                left: `${position.left}%`,
                width: `${position.width}%`,
                transform,
                pointerEvents: "none",
                userSelect: "none",
              }}
            />
          );
        };

        return (
          <>
            {/* Pass 1 — background (e.g. magic circles) */}
            {layers.background.map(renderAccessory)}

            {/* Pass 2 — behind the cat (capes, wings, aura) */}
            {layers.behindCat.map(renderAccessory)}

            {/* Pass 3 — base artwork — key forces remount (and kittyFadeIn replay) on stage/mood change */}
            <img key={src} src={src} alt="" className="kitty-image" draggable={false} />

            {/*
              Overlay SVG — sits pixel-perfect on top of the webp.
              viewBox must match the actual rendered image size for this stage.
            */}
            <svg
              className="kitty-overlay"
              viewBox={`0 0 ${eye.size} ${eye.size}`}
              aria-hidden="true"
            >
              {/* LEFT EAR — hidden in sleepy mode */}
              {mood !== "sleepy" && (
                <g className={`kitty-ear-l${earWiggle ? " ear-wig-l" : ""}`}>
                  <path d={ear.lOuter} fill={ear.lOuterFill} opacity={0.95} />
                  <path d={ear.lInner} fill={ear.lInnerFill} opacity={0.85} />
                </g>
              )}

              {/* RIGHT EAR */}
              {mood !== "sleepy" && (
                <g className={`kitty-ear-r${earWiggle ? " ear-wig-r" : ""}`}>
                  <path d={ear.rOuter} fill={ear.rOuterFill} opacity={0.95} />
                  <path d={ear.rInner} fill={ear.rInnerFill} opacity={0.85} />
                </g>
              )}

              {/* TAIL — stage 3+ animated via CSS image sway on .kitty-image, no SVG overlay needed */}

              {/* LEFT EYELID */}
              <clipPath id={`clip-l-${stage}`}>
                <ellipse cx={eye.lx} cy={eye.ly} rx={eye.rx2} ry={eye.ry2} />
              </clipPath>
              <rect
                x={eye.lx - eye.rx2 - 2}
                y={eye.ly - eye.ry2 - 2}
                width={(eye.rx2 + 2) * 2}
                height={(eye.ry2 + 2) * 2}
                fill={eye.fill}
                clipPath={`url(#clip-l-${stage})`}
                className={`kitty-eyelid kitty-eyelid-l${blinking ? " eyelid-blink-l" : ""}`}
              />

              {/* RIGHT EYELID */}
              <clipPath id={`clip-r-${stage}`}>
                <ellipse cx={eye.rx} cy={eye.ry} rx={eye.rx2} ry={eye.ry2} />
              </clipPath>
              <rect
                x={eye.rx - eye.rx2 - 2}
                y={eye.ry - eye.ry2 - 2}
                width={(eye.rx2 + 2) * 2}
                height={(eye.ry2 + 2) * 2}
                fill={eye.fill}
                clipPath={`url(#clip-r-${stage})`}
                className={`kitty-eyelid kitty-eyelid-r${blinking ? " eyelid-blink-r" : ""}`}
              />
            </svg>

            {/* Pass 4 — front (glasses, hats, bows, crowns, necklace, halo, wand) */}
            {layers.front.map(renderAccessory)}
          </>
        );
      })()}
    </div>

  );
}

const faqSections = [
  {
    title: "🐾 What is Grub?",
    content: "Grub is your tiny white kitty companion who lives on-chain. She grows, reacts to your daily care, and evolves through 4 stages over roughly a month of visits. She has real feelings — ignore her and she goes feral. At max stage she becomes a Moonmilk Mythic, your future NFT with unique traits shaped by how you raised her.",
  },
  {
    title: "✦ Daily Check-In",
    content: "Every day starts with a Check-In. This unlocks all your care actions for that day and counts toward your streak.\n\nCheck-in costs $0.01 (one cent in USD) worth of ETH on Base — not 0.01 ETH. Wallet payment is coming soon — it is free for now.\n\nCheck in 7 days in a row and your next check-in drops a +5 XP bonus straight into Grub. Miss a day and your streak resets to 0 and you start counting again.\n\nYou must check in each day to feed, play, groom, or nap. Missing a day does not hurt Grub directly, but your streak and the 7-day bonus reset.",
  },
  {
    title: "🍼 Feeding",
    content: "Feed Grub up to 3 times per day. Each feed costs 8 Glimmer and gives +3 XP (plus any Bond bonus). Feeding raises Hunger by 28, Happiness by 9, and Care by 12. If Hunger drops below 38 she gets grumpy. Below 18 she goes feral. Always keep her fed.",
  },
  {
    title: "✨ Glimmer",
    content: "Glimmer is the resource used to feed Grub. It mines passively while you are away — about 1 Glimmer per hour, up to 48 hours stored (48 max). You do not need to do anything — just come back and it is waiting. Each feed costs 8 Glimmer, so 3 feeds per day costs 24 total.",
  },
  {
    title: "🎮 Care Actions",
    content: "After checking in you get these daily actions:\n\n• Feed x3 — costs 8 Glimmer, +3 XP. Raises Hunger, Happiness, Care.\n• Play x2 — free, +2 XP. Raises Happiness, uses some Energy and Hunger.\n• Groom x2 — free, +2 XP. Raises Care and Happiness.\n• Nap x1 — free, +1 XP. Restores Energy.\n\nAll actions reset at midnight. Max XP per day is around 16, so reaching Mythic takes about 90 days of consistent care — roughly 3 months. Check in 7 days in a row for a +5 XP bonus drop.",
  },
  {
    title: "💛 Bond & XP Bonus",
    content: "Tap Grub directly (tap the cat itself, not the buttons) to build Bond. Up to 20 taps per day count toward Bond. Higher Bond gives a permanent XP bonus on all care actions:\n\n• Bond 25 → +5% XP on every action\n• Bond 50 → +10% XP on every action\n• Bond 75 → +15% XP on every action\n• Bond 100 → +20% XP on every action\n\nBond also unlocks special dialogue. If you stop tapping for more than 24 hours, Bond decays 1 point per hour after that. Tap daily to keep it high.",
  },
  {
    title: "😺 Moods",
    content: "Grub has 5 moods that change her look and dialogue:\n\n• Content — well fed and happy, all is fine\n• Smug — thriving, Happiness above 82 and Care above 74\n• Hungry — Hunger dropped below 38, feed her soon\n• Feral — neglected 72+ hours, or Hunger under 18, or Care under 16\n• Sleepy — late night only, between 11pm and 5am\n\nEach mood changes her image, her reactions when tapped, and her idle dialogue.",
  },
  {
    title: "🔥 Streak",
    content: "Your streak counts consecutive days you have checked in. It goes up by 1 each time you check in on a new day. Missing a day resets your streak to 0. Streak contributes to your Growth score, which tracks how well-raised Grub is overall. Consistent daily visits are the fastest path to Mythic.",
  },
  {
    title: "🌱 Evolution Stages",
    content: "Grub evolves through 4 stages as you earn XP:\n\n• Tiny Cloud (Newborn) — 0 XP\n• Pocket Purr (Kitten) — 480 XP (~30 days)\n• Pearl Floof (Young Cat) — 960 XP (~60 days)\n• Moonmilk Mythic (Adult) — 1440 XP (~90 days)\n\nEach stage has unique artwork for all moods. At full Bond (+20% bonus) you earn slightly more XP per day and can reach Mythic a few days sooner. Check in 7 days in a row for a +5 XP bonus each cycle.",
  },
  {
    title: "🌙 Moonmilk Mythic",
    content: "The final stage is Moonmilk Mythic — a fully bonded adult cat. This will become your NFT on-chain, with traits influenced by how you raised her: your streak, Bond level, care choices, and total XP all shape what she looks like. More details coming soon.",
  },
  {
    title: "👗 Closet & Accessories",
    content: "The Closet lets you dress up Grub with accessories unlocked using USDC on Base.\n\nEach stage has its own accessories:\n• Stage 1 (Tiny Cloud) — $0.10 each: bows, glasses\n• Stage 2 (Pocket Purr) — $0.20 each: crown, cape, wand\n• Stage 3 (Pearl Floof) — $0.30 each: wings, wizard hat, tail charm\n• Stage 4 (Moonmilk Mythic) — $0.40 each: legendary set, 8 pieces\n\nHow it works:\n• Tap Unlock to purchase an accessory with USDC on Base\n• Once unlocked it is yours forever — no re-buying\n• Tap Equip to put it on Grub, Remove to take it off\n• You can mix and match freely within a stage\n• You can browse any stage's accessories but can only equip items that match Grub's current stage\n\nAccessories only show on Grub when she is Content or Smug. They are hidden when she is Hungry, Feral, or Sleepy — keep her happy to show off her outfits!",
  },
  {
    title: "⚠️ Going Feral",
    content: "Grub goes feral if:\n• You have been away for 72+ hours\n• Her Hunger drops below 18\n• Her Care score drops below 16\n\nShe will not die — but she will be unhappy and unresponsive. To recover: check in, feed her 2-3 times over a day, and groom her. Stats will climb back up. Feral is fully recoverable with a little patience.",
  },
];

function FaqModal({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq-backdrop" onClick={onClose}>
      <div className="faq-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="faq-header">
          <h2>How to care for Grub</h2>
          <button className="faq-close" type="button" onClick={onClose}>✕</button>
        </div>
        <div className="faq-body">
          {faqSections.map((sec, i) => (
            <div key={i} className={`faq-item${open === i ? " faq-item-open" : ""}`}>
              <button
                type="button"
                className="faq-q"
                onClick={() => setOpen(open === i ? null : i)}
              >
                <span>{sec.title}</span>
                <span className="faq-chevron">{open === i ? "▲" : "▼"}</span>
              </button>
              {open === i && (
                <p className="faq-a">{sec.content}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="mini-track">
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
