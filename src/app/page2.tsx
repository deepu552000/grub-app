"use client";

import sdk from "@farcaster/miniapp-sdk";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState, useRef } from "react";

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
    minXp: 234,
    note: "Curious, playful, and starting to recognize your care.",
    world: "Soft playroom",
  },
  {
    name: "Pearl Floof",
    title: "Young Cat",
    minXp: 676,
    note: "Graceful now, but still melts when you groom her.",
    world: "Pearl window",
  },
  {
    name: "Moonmilk Mythic",
    title: "Adult Mythic",
    minXp: 1456,
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

// How many times each care action can be used per day - this is what makes
// progress take roughly a month instead of one sitting. XP values are tuned
// against these caps (see design notes: ~52 max xp/day -> ~28 days to Mythic).
const dailyLimits: Record<ActionType, number> = {
  feed: 3,
  play: 2,
  groom: 2,
  nap: 1,
};

const xpPerAction: Record<ActionType, number> = {
  feed: 8,
  play: 6,
  groom: 6,
  nap: 4,
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
    const mined = Math.min(72, Math.floor(hoursAway * 4));
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
    };
  } catch {
    return { ...defaultState, lastVisit: Date.now() };
  }
}

let floatId = 0;

export default function Home() {
  // Server and first client render both use defaultState - no mismatch possible.
  const [state, setState] = useState<PetState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [lastAction, setLastAction] = useState("You found a tiny white kitty.");
  const [carePulse, setCarePulse] = useState<ActionType | "">("");
  const [poked, setPoked] = useState(false);
  const [floats, setFloats] = useState<FloatingNumber[]>([]);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const kittyRef = useRef<HTMLDivElement>(null);

  // Real save data only loads after mount, in the browser.
  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  useEffect(() => {
    sdk.actions.ready().catch(() => {
      // Local browser testing is expected to land here.
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

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
  const lastActionHasBonus = lastAction.includes("bond bonus");
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

    setState((current) => {
      const isNewCareDay = current.lastCareDay !== todayKey();
      const next: PetState = {
        ...current,
        lastVisit: Date.now(),
        lastCareDay: todayKey(),
        streak: isNewCareDay ? current.streak + 1 : current.streak,
        actionsToday: {
          ...current.actionsToday,
          [action]: (current.actionsToday[action] ?? 0) + 1,
        },
      };

      // Bond gives a small, never-punishing XP bonus - bond 0 means no change from before.
      // The exact (fractional) amount is what actually gets stored, so the bonus is real,
      // not just a rounding-erased preview. The floating text always shows a clean whole
      // number; the bonus itself is called out in the persistent speech-panel message below,
      // since the floating text fades too fast to actually read.
      const baseXp = xpPerAction[action];
      const bonusPct = bondXpBonusPct(current.bond);
      const exactXp = baseXp * bondXpMultiplier(current.bond);
      const xpLabel = `+${baseXp} xp`;
      const bonusNote = bonusPct > 0 ? ` (+${bonusPct}% bond bonus)` : "";

      if (action === "feed") {
        next.hunger = clamp(current.hunger + 28);
        next.happiness = clamp(current.happiness + 9);
        next.energy = clamp(current.energy + 5);
        next.care = clamp(current.care + 12);
        next.xp = current.xp + exactXp;
        next.glimmer = Math.max(0, current.glimmer - FEED_GLIMMER_COST);
        setLastAction(`Fed with warm moonmilk. Tiny trust increased.${bonusNote}`);
        spawnFloat(xpLabel);
      }

      if (action === "play") {
        next.happiness = clamp(current.happiness + 24);
        next.energy = clamp(current.energy - 12);
        next.hunger = clamp(current.hunger - 8);
        next.care = clamp(current.care + 7);
        next.xp = current.xp + exactXp;
        setLastAction(`Played softly. The floof remembered joy.${bonusNote}`);
        spawnFloat(xpLabel);
      }

      if (action === "groom") {
        next.care = clamp(current.care + 26);
        next.happiness = clamp(current.happiness + 12);
        next.energy = clamp(current.energy + 2);
        next.xp = current.xp + exactXp;
        setLastAction(`Brushed into cloud status. Extremely precious.${bonusNote}`);
        spawnFloat(xpLabel);
      }

      if (action === "nap") {
        next.energy = clamp(current.energy + 34);
        next.hunger = clamp(current.hunger - 5);
        next.happiness = clamp(current.happiness + 4);
        next.xp = current.xp + exactXp;
        setLastAction(`Nap complete. Purr engine recalibrated.${bonusNote}`);
        spawnFloat(xpLabel);
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

  return (
    <main className={`app-shell mood-${mood}`}>
      <section className="phone-frame">
        <header className="topbar">
          <div>
            <p className="eyebrow">Farcaster Mini App</p>
            <h1>Grub</h1>
          </div>
          <button className="ghost-button" type="button" onClick={shareKitty}>
            Cast
          </button>
        </header>

        <section className="hero">
          <div className="stage-copy">
            <span>{stage.title}</span>
            <h2>{stage.name}</h2>
            <p>{stage.note}</p>
          </div>

          <div className="kitty-stage-wrap" ref={kittyRef}>
            <Kitty
              stage={stageIndex}
              mood={mood}
              growth={growth}
              carePulse={carePulse}
              poked={poked}
              onPoke={pokeKitty}
            />
            {ripples.map((r) => (
              <span
                key={r.id}
                className="tap-ripple"
                style={{ left: r.x, top: r.y }}
              />
            ))}
            {floats.map((f) => (
              <span
                key={f.id}
                className="floating-number"
                style={{ left: f.x, top: f.y }}
              >
                {f.text}
              </span>
            ))}
          </div>

          <div className="world-label">
            <span>{stage.world}</span>
            <strong>{growth}% grown</strong>
          </div>
        </section>

        <section className="speech">
          <p>{line}</p>
          <span className={lastActionHasBonus ? "has-bonus" : ""}>{lastAction}</span>
        </section>

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

        <section className="actions" aria-label="Care actions">
          <button
            type="button"
            onClick={() => doCare("feed")}
            disabled={state.actionsToday.feed >= dailyLimits.feed || state.glimmer < FEED_GLIMMER_COST}
          >
            <span>Feed</span>
            <small>
              {state.actionsToday.feed >= dailyLimits.feed
                ? "0 left today"
                : state.glimmer < FEED_GLIMMER_COST
                  ? "need glimmer"
                  : `${dailyLimits.feed - state.actionsToday.feed} left today`}
            </small>
          </button>
          <button
            type="button"
            onClick={() => doCare("play")}
            disabled={state.actionsToday.play >= dailyLimits.play}
          >
            <span>Play</span>
            <small>{Math.max(0, dailyLimits.play - state.actionsToday.play)} left today</small>
          </button>
          <button
            type="button"
            onClick={() => doCare("groom")}
            disabled={state.actionsToday.groom >= dailyLimits.groom}
          >
            <span>Groom</span>
            <small>{Math.max(0, dailyLimits.groom - state.actionsToday.groom)} left today</small>
          </button>
          <button
            type="button"
            onClick={() => doCare("nap")}
            disabled={state.actionsToday.nap >= dailyLimits.nap}
          >
            <span>Nap</span>
            <small>{Math.max(0, dailyLimits.nap - state.actionsToday.nap)} left today</small>
          </button>
        </section>
        <p className="actions-hint">Care actions refresh tomorrow. Tap Grub anytime to build Bond.</p>
      </section>
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

// Per-stage eye positions — coordinate space matches each stage's actual pixel size.
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
  3: { lx: 72,  ly: 106, rx: 134, ry: 106, rx2: 21, ry2: 22, fill: "#f5ebe0", size: 208 },
  4: { lx: 80,  ly: 118, rx: 150, ry: 118, rx2: 23, ry2: 24, fill: "#f5ebe0", size: 232 },
};

function Kitty({
  stage,
  mood,
  growth,
  carePulse,
  poked,
  onPoke,
}: {
  stage: number;
  mood: Mood;
  growth: number;
  carePulse: ActionType | "";
  poked: boolean;
  onPoke: (point?: { x: number; y: number }) => void;
}) {
  const growthRatio = growth / 100;
  const src = catImageSrc(stage, mood);
  const eye = eyeConfig[stage] ?? eyeConfig[1];

  // Track blink state separately from poke so idle blinks don't interfere
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idle blink: fires every 3–5 seconds
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

  // Force a blink on every poke as well
  useEffect(() => {
    if (poked) {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 220);
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

      {/* Base artwork — key forces remount (and kittyFadeIn replay) on stage/mood change */}
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
        {/* Left eyelid */}
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

        {/* Right eyelid */}
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
