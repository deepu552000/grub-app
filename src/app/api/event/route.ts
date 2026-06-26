import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export type DailyEvent = {
  id: string;
  emoji: string;
  title: string;
  message: string;
  effect: Partial<{
    glimmer: number;
    xp: number;
    energy: number;
    hunger: number;
    happiness: number;
    care: number;
  }>;
};

const EVENT_POOL: DailyEvent[] = [
  {
    id: "feather",
    emoji: "🪶",
    title: "Feather Find",
    message: "Grub found a feather and batted it around for an hour.",
    effect: { glimmer: 5 },
  },
  {
    id: "rainy_nap",
    emoji: "🌧️",
    title: "Rainy Day Nap",
    message: "Rain on the window. Grub slept through everything. Energy restored.",
    effect: { energy: 15 },
  },
  {
    id: "sunny_window",
    emoji: "☀️",
    title: "Warm Window Patch",
    message: "A perfect sunbeam appeared. Grub absorbed it entirely.",
    effect: { happiness: 10, energy: 5 },
  },
  {
    id: "mystery_crumb",
    emoji: "✨",
    title: "Mystery Crumb",
    message: "Grub found something on the floor. Ate it. Felt great.",
    effect: { hunger: 10, glimmer: 3 },
  },
  {
    id: "midnight_zoomies",
    emoji: "💨",
    title: "Midnight Zoomies",
    message: "3am. Grub ran laps for no reason. Used all the energy. Worth it.",
    effect: { happiness: 12, energy: -8 },
  },
  {
    id: "glimmer_surge",
    emoji: "💎",
    title: "Glimmer Surge",
    message: "Something magical in the air today. Glimmer flows freely.",
    effect: { glimmer: 10 },
  },
  {
    id: "xp_bonus",
    emoji: "⭐",
    title: "Lucky Day",
    message: "The stars aligned for Grub. Extra XP awarded just for existing.",
    effect: { xp: 8 },
  },
  {
    id: "stranger_pet",
    emoji: "🤝",
    title: "Stranger's Pat",
    message: "A stranger reached over and pet Grub. Grub allowed it. Bond rose.",
    effect: { care: 8, happiness: 5 },
  },
  {
    id: "yarn_tangle",
    emoji: "🧶",
    title: "Yarn Tangle",
    message: "Grub found the yarn drawer. Now nothing is okay but Grub is happy.",
    effect: { happiness: 15, care: -5 },
  },
  {
    id: "phantom_smell",
    emoji: "👃",
    title: "Phantom Smell",
    message: "Grub smelled something incredible and won't say what it was.",
    effect: { glimmer: 4, happiness: 6 },
  },
  {
    id: "cold_floor",
    emoji: "🧊",
    title: "Cold Floor",
    message: "Grub stepped on the cold floor and deeply reconsidered every choice.",
    effect: { energy: -5, happiness: -5, glimmer: 2 },
  },
  {
    id: "cloud_nap",
    emoji: "☁️",
    title: "Cloud Nap",
    message: "Grub found a soft spot and napped so hard, energy feels infinite.",
    effect: { energy: 20 },
  },
  {
    id: "treat_drop",
    emoji: "🍬",
    title: "Treat Drop",
    message: "Someone dropped a treat nearby. Grub investigated. Ate it. Glimmer.",
    effect: { hunger: 8, glimmer: 6 },
  },
  {
    id: "mirror_stare",
    emoji: "🪞",
    title: "Mirror Stare",
    message: "Grub stared into the mirror for 12 minutes. Emerged changed. +XP.",
    effect: { xp: 5, care: 5 },
  },
  {
    id: "storm_night",
    emoji: "⛈️",
    title: "Storm Night",
    message: "Thunder outside. Grub hid under the blanket. Happiness suffered.",
    effect: { happiness: -8, energy: 10 },
  },
  {
    id: "full_moon",
    emoji: "🌕",
    title: "Full Moon",
    message: "Full moon energy. Grub vibrated at a frequency no one understands.",
    effect: { glimmer: 8, xp: 3 },
  },
  {
    id: "visitor",
    emoji: "🚪",
    title: "Unexpected Visitor",
    message: "Someone came over. Grub was suspicious but ultimately allowed pets.",
    effect: { bond: 5, happiness: 8 } as DailyEvent["effect"],
  },
  {
    id: "found_blanket",
    emoji: "🛏️",
    title: "Best Blanket Found",
    message: "Grub located the softest blanket in existence. Will not be leaving.",
    effect: { energy: 12, happiness: 10 },
  },
  {
    id: "bug_spotted",
    emoji: "🐛",
    title: "Bug Spotted",
    message: "A bug entered Grub's domain. It will not be seen again. Glimmer up.",
    effect: { glimmer: 7, happiness: 8 },
  },
  {
    id: "empty_bowl",
    emoji: "🥣",
    title: "Empty Bowl",
    message: "Grub's bowl was empty for 4 minutes. This was a crisis. Hunger fell.",
    effect: { hunger: -10, glimmer: 3 },
  },
];

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// Seeded deterministic pick — same date always picks the same event
function pickEventForDate(dateKey: string): DailyEvent {
  let hash = 0;
  for (let i = 0; i < dateKey.length; i++) {
    hash = (hash * 31 + dateKey.charCodeAt(i)) >>> 0;
  }
  return EVENT_POOL[hash % EVENT_POOL.length];
}

export async function GET() {
  try {
    const dateKey = getTodayKey();
    const redisKey = `grub:event:${dateKey}`;

    // Check cache first
    let event = await kv.get<DailyEvent>(redisKey);

    if (!event) {
      // Generate and cache for 25 hours
      event = pickEventForDate(dateKey);
      await kv.set(redisKey, event, { ex: 25 * 60 * 60 });
    }

    return NextResponse.json({ date: dateKey, event });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
