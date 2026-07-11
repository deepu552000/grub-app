// lib/accessories.ts
//
// Accessory catalog + positioning for ALL stages.
//
// Stage 1 slots: "head" | "face"   (bow, glasses)
// Stage 2 slots: "crown" | "cape" | "wand"  (crown, cape, magic wand)
// Stage 3 slots: "wings" | "hat" | "tail"  (wings, wizard hat, tail charm)
// Stage 4 slots: "crown" | "wings" | "halo" | "aura" | "circle"  (legendary set, 12 pcs)
//
// Positions are percentages of the .kitty-wrap box.
// Stage 1 kitty-wrap = 168×168px. Stage 2 kitty-wrap = 200×200px (see globals.css).
//
// top/left = CENTER point of the accessory (matches translate(-50%,-50%) used
// when rendering). Numbers = "where the middle of the accessory sits".
//
// Accessories are ONLY rendered on the plain "content/smug" cat image for each
// stage (stage1.webp, stage2.webp). Not on hungry/feral/sleepy variants.

export type AccessorySlot =
  | "head"
  | "face"
  | "crown"
  | "cape"
  | "wand"
  | "wings"
  | "aura"
  | "circle"
  | "tail"
  | "halo"
  | "hat";

// Render layer — controls draw order relative to the cat image, NOT slot
// exclusivity (slot still handles "only one hat at a time" type rules).
//
//   background  → drawn first, fully behind the cat (e.g. magic circles)
//   behindCat   → drawn after background, still behind the cat (capes, wings, aura)
//   front       → drawn last, on top of the cat (glasses, hats, crowns, wands, etc.)
//
// This is the ONLY thing that determines visual stacking order. Adding a new
// accessory never requires touching render logic — just pick the right layer.
export type AccessoryLayer = "background" | "behindCat" | "front";

export type Accessory = {
  id: string;
  name: string;
  slot: AccessorySlot;
  layer: AccessoryLayer; // draw order relative to the cat image
  stage: number;      // which cat stage this accessory belongs to
  costUsd: number;    // USD price (stage1=$0.10, stage2=$0.20, stage3=$0.30, stage4=$0.40)
  imageUrl: string;
};

// ── Stage 1 accessories ──────────────────────────────────────────────────────
export const STAGE1_ACCESSORIES: Accessory[] = [
  {
    id: "bow-black",
    name: "Black Bow",
    slot: "head",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/bow-black.webp",
  },
  {
    id: "bow-red",
    name: "Red Bow",
    slot: "head",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/bow-red.webp",
  },
  {
    id: "party-hat-pink",
    name: "Pink Party Hat",
    slot: "head",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/party-hat-pink.webp",
  },
  {
    id: "party-hat-blue",
    name: "Blue Party Hat",
    slot: "head",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/party-hat-blue.webp",
  },
  {
    id: "glasses-gold",
    name: "Gold Glasses",
    slot: "face",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/glasses-gold.webp",
  },
  {
    id: "glasses-black",
    name: "Black Glasses",
    slot: "face",
    layer: "front",
    stage: 1,
    costUsd: 0.10,
    imageUrl: "/accessories/glasses-black.webp",
  },
];

// ── Stage 2 accessories ──────────────────────────────────────────────────────
export const STAGE2_ACCESSORIES: Accessory[] = [
  {
    id: "crown-gold",
    name: "Gold Crown",
    slot: "crown",
    layer: "front",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/crown-gold.webp",
  },
  {
    id: "crown-silver",
    name: "Silver Crown",
    slot: "crown",
    layer: "front",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/crown-silver.webp",
  },
  {
    id: "cape-purple",
    name: "Purple Cape",
    slot: "cape",
    layer: "behindCat",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/cape-purple.webp",
  },
  {
    id: "cape-blue",
    name: "Blue Cape",
    slot: "cape",
    layer: "behindCat",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/cape-blue.webp",
  },
  {
    id: "wand-star",
    name: "Star Wand",
    slot: "wand",
    layer: "front",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/wand-star.webp",
  },
  {
    id: "wand-moon",
    name: "Moon Wand",
    slot: "wand",
    layer: "front",
    stage: 2,
    costUsd: 0.20,
    imageUrl: "/accessories/wand-moon.webp",
  },
];

// ── Stage 3 accessories ──────────────────────────────────────────────────────
// Three independent slots — wings, hat, necklace — same pattern as stage 2's
// crown/cape/wand: 2 color options each, all freely combinable, no exclusions.
export const STAGE3_ACCESSORIES: Accessory[] = [
  {
    id: "wings-white",
    name: "White Angel Wings",
    slot: "wings",
    layer: "behindCat",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/wings-white.webp",
  },
  {
    id: "wings-pink",
    name: "Iridescent Angel Wings",
    slot: "wings",
    layer: "behindCat",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/wings-pink.webp",
  },
  {
    id: "wizard-hat-purple",
    name: "Purple Wizard Hat",
    slot: "hat",
    layer: "front",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/wizard-hat-purple.webp",
  },
  {
    id: "wizard-hat-blue",
    name: "Blue Wizard Hat",
    slot: "hat",
    layer: "front",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/wizard-hat-blue.webp",
  },
  {
    id: "tail-charm-gold",
    name: "Gold Star Tail Charm",
    slot: "tail",
    layer: "front",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/tail-charm-gold.webp",
  },
  {
    id: "tail-charm-sakura",
    name: "Sakura Star Tail Charm",
    slot: "tail",
    layer: "front",
    stage: 3,
    costUsd: 0.30,
    imageUrl: "/accessories/tail-charm-sakura.webp",
  },
];

// ── Stage 4 accessories ──────────────────────────────────────────────────────
// Legendary set — 5 independent slots, 12 total pieces, all freely combinable.
// circle (background) → aura (behindCat) → wings (behindCat) → [cat] → crown/halo (front)
export const STAGE4_ACCESSORIES: Accessory[] = [
  // ── Crown (front) ──
  {
    id: "crown-flame-gold",
    name: "Gold Flaming Crown",
    slot: "crown",
    layer: "front",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/crown-flame-gold.webp",
  },
  {
    id: "crown-flame-dark",
    name: "Dark Flaming Crown",
    slot: "crown",
    layer: "front",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/crown-flame-dark.webp",
  },
  // ── Wings (behindCat) ──
  {
    id: "wings-dragon-fire",
    name: "Fire Dragon Wings",
    slot: "wings",
    layer: "behindCat",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/wings-dragon-fire.webp",
  },
  {
    id: "wings-dragon-cosmic",
    name: "Cosmic Dragon Wings",
    slot: "wings",
    layer: "behindCat",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/wings-dragon-cosmic.webp",
  },
  // ── Halo (front) ──
  {
    id: "halo-neon",
    name: "Neon Halo",
    slot: "halo",
    layer: "front",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/halo-neon.webp",
  },
  {
    id: "halo-ornate",
    name: "Ornate Crystal Halo",
    slot: "halo",
    layer: "front",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/halo-ornate.webp",
  },
  // ── Aura (behindCat) ──
  {
    id: "aura-purple",
    name: "Purple Flame Aura",
    slot: "aura",
    layer: "behindCat",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/aura-purple.webp",
  },
  {
    id: "aura-blue",
    name: "Blue Flame Aura",
    slot: "aura",
    layer: "behindCat",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/aura-blue.webp",
  },
  {
    id: "aura-fire",
    name: "Fire Aura",
    slot: "aura",
    layer: "behindCat",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/aura-fire.webp",
  },
  // ── Circle (background) ──
  {
    id: "circle-blue",
    name: "Blue Magic Circle",
    slot: "circle",
    layer: "background",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/circle-blue.webp",
  },
  {
    id: "circle-purple",
    name: "Purple Magic Circle",
    slot: "circle",
    layer: "background",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/circle-purple.webp",
  },
  {
    id: "circle-gold",
    name: "Gold Magic Circle",
    slot: "circle",
    layer: "background",
    stage: 4,
    costUsd: 0.40,
    imageUrl: "/accessories/circle-gold.webp",
  },
];

export const ACCESSORIES: Accessory[] = [
  ...STAGE1_ACCESSORIES,
  ...STAGE2_ACCESSORIES,
  ...STAGE3_ACCESSORIES,
  ...STAGE4_ACCESSORIES,
];

export function getAccessory(id: string): Accessory | undefined {
  return ACCESSORIES.find((a) => a.id === id);
}

export function getAccessoriesForStage(stage: number): Accessory[] {
  return ACCESSORIES.filter((a) => a.stage === stage);
}

// Render order, back-most to front-most. The Kitty component draws three
// passes in exactly this order — background, behindCat, [cat image],
// front — so a brand new accessory only ever needs a `layer` value here,
// never a new pass or a code change in page.tsx.
export const LAYER_ORDER: AccessoryLayer[] = ["background", "behindCat", "front"];

// Given a list of equipped accessory ids, group + order them by layer so the
// caller can render them in up to 3 simple passes without re-deriving order
// itself each time.
export function groupEquippedByLayer(
  equippedIds: string[]
): Record<AccessoryLayer, Accessory[]> {
  const groups: Record<AccessoryLayer, Accessory[]> = {
    background: [],
    behindCat: [],
    front: [],
  };

  for (const id of equippedIds) {
    const accessory = getAccessory(id);
    if (!accessory) continue;
    groups[accessory.layer].push(accessory);
  }

  return groups;
}

// ── Positions ────────────────────────────────────────────────────────────────
export type AccessoryPosition = {
  top: number;             // % of kitty-wrap height, center point
  left: number;            // % of kitty-wrap width, center point
  width: number;           // % of kitty-wrap width
  rotate?: number;         // degrees, clockwise. Optional — omit for no tilt.
};

// Stage 1 positions (168×168px kitty-wrap, stage1.webp content/smug)
const STAGE1_POSITIONS: Record<string, AccessoryPosition> = {
  "bow-black":      { top: 24, left: 50, width: 30 },
  "bow-red":        { top: 24, left: 50, width: 30 },
  "party-hat-pink": { top: 12, left: 50, width: 40 },
  "party-hat-blue": { top: 12, left: 50, width: 40 },
  "glasses-gold":   { top: 45, left: 50, width: 58 },
  "glasses-black":  { top: 45, left: 50, width: 58 },
};

// Stage 2 positions (stage2.webp content/smug).
// Images are now pre-sized to match cat proportions so width% can stay modest.
//
// Cape note: this character's head is wider than its neck/shoulders at every
// height, so a cape's front clasp/collar piece can never be visible behind
// it — only the side flaps peek out. top/width below are tuned so the flaps
// show clearly near the cheeks without the clasp area looking awkward.
const STAGE2_POSITIONS: Record<string, AccessoryPosition> = {
  "crown-gold":   { top: 13, left: 50, width: 32 },
  "crown-silver": { top: 13, left: 50, width: 32 },
  "cape-purple":  { top: 50, left: 50, width: 100 },
  "cape-blue":    { top: 50, left: 50, width: 100 },
  "wand-star":    { top: 88, left: 88, width: 32, rotate: 35 },
  "wand-moon":    { top: 88, left: 88, width: 32, rotate: 35 },
};

// Stage 3 positions (stage3.webp content/smug, 208×208px kitty-wrap).
//
// Wizard hat note: hat-blue's art is drawn at a jaunty tilted angle (unlike
// hat-purple, which is front-facing), so its left/top differ from
// hat-purple to visually compensate and land centered on the head either way.
const STAGE3_POSITIONS: Record<string, AccessoryPosition> = {
  "wings-white":       { top: 58, left: 50, width: 160 },
  "wings-pink":        { top: 58, left: 50, width: 160 },
  "wizard-hat-purple": { top: 10, left: 50, width: 68 },
  "wizard-hat-blue":   { top: 14, left: 50, width: 68, rotate: -3 },
  "tail-charm-gold":   { top: 78, left: 74, width: 14 },
  "tail-charm-sakura": { top: 78, left: 74, width: 14 },
};

// Stage 4 positions (stage4.webp, larger cat — estimated, tune after testing).
// circle sits at bottom (background), aura/wings wrap the body (behindCat),
// crown/halo float above the head (front).
const STAGE4_POSITIONS: Record<string, AccessoryPosition> = {
  "crown-flame-gold":   { top: 2,  left: 50, width: 44 },
  "crown-flame-dark":   { top: 2,  left: 50, width: 44 },
  "wings-dragon-fire":  { top: 44, left: 50, width: 170 },
  "wings-dragon-cosmic":{ top: 48, left: 50, width: 170 },
  "halo-neon":          { top: 8,  left: 50, width: 72 },
  "halo-ornate":        { top: 8,  left: 50, width: 45 },
  "aura-purple":        { top: 60, left: 50, width: 130 },
  "aura-blue":          { top: 60, left: 50, width: 130 },
  "aura-fire":          { top: 60, left: 50, width: 130 },
  "circle-blue":        { top: 88, left: 50, width: 155 },
  "circle-purple":      { top: 88, left: 50, width: 155 },
  "circle-gold":        { top: 88, left: 50, width: 155 },
};
const ALL_POSITIONS: Record<string, AccessoryPosition> = {
  ...STAGE1_POSITIONS,
  ...STAGE2_POSITIONS,
  ...STAGE3_POSITIONS,
  ...STAGE4_POSITIONS,
};

export function getPosition(accessoryId: string): AccessoryPosition | null {
  return ALL_POSITIONS[accessoryId] ?? null;
}

// ── Guard: which stage+mood combos allow accessory rendering ─────────────────
// Only the "plain" content/smug image for each stage supports accessories.
// Hungry (a), feral (b), sleepy (c) variants use different art — never overlay.
export function accessoriesAllowedFor(stage: number, mood: string): boolean {
  if (mood !== "content" && mood !== "smug") return false;
  return stage === 1 || stage === 2 || stage === 3 || stage === 4;
}

// Which stage's accessories can be EQUIPPED right now (cat must be at that stage).
// Users can browse/buy any stage from the closet, but equip is blocked unless
// their cat is currently at the matching stage.
export function canEquipForStage(currentCatStage: number, accessoryStage: number): boolean {
  return currentCatStage === accessoryStage;
}

// ── Accessory Festival — one-time 50% off, all stages, 3 days ───────────────
// 7 Jul 00:00 IST → 10 Jul 00:00 IST.
//
// This is the SINGLE source of truth for the discounted price, used by BOTH:
//   - Client.tsx's accessoryUnlockUsd() → Closet UI price display AND the
//     actual USDC amount sent via sendUsdcPayment()
//   - app/api/pet/route.ts's on-chain payment verification (expectedPrice)
//
// Computed fresh on every call (never cached at module load) — a warm
// serverless function instance persists across many requests, so a
// once-at-cold-start price would keep serving the OLD price straight through
// the festival's start/end boundary until the next cold start happened to
// occur. Computing it live on every call means the boundary is always exact,
// on both sides, regardless of server warmth.
export const ACCESSORY_FESTIVAL_DISCOUNT_PERCENT = 50;
export const ACCESSORY_FESTIVAL_START = Date.UTC(2026, 6, 6, 18, 30); // 7 Jul 2026 00:00 IST
export const ACCESSORY_FESTIVAL_END   = Date.UTC(2026, 6, 9, 18, 30); // 10 Jul 2026 00:00 IST
// Teaser window — the 24h immediately before the festival goes live, so
// people can see it coming and be ready. Same pattern as the referral
// festival's TEASER_START in Client.tsx.
export const ACCESSORY_FESTIVAL_TEASER_START = ACCESSORY_FESTIVAL_START - 24 * 60 * 60 * 1000; // 6 Jul 2026 00:00 IST

export function isAccessoryFestivalLive(nowMs: number = Date.now()): boolean {
  return nowMs >= ACCESSORY_FESTIVAL_START && nowMs < ACCESSORY_FESTIVAL_END;
}

// True only during the 24h teaser window BEFORE the festival goes live —
// false once isAccessoryFestivalLive() becomes true, same non-overlapping
// relationship as the referral festival's teaser/live pair.
export function isAccessoryFestivalTeaser(nowMs: number = Date.now()): boolean {
  return nowMs >= ACCESSORY_FESTIVAL_TEASER_START && nowMs < ACCESSORY_FESTIVAL_START;
}

// The price to charge RIGHT NOW for this accessory — discounted during the
// festival window, full price otherwise. Returns null ONLY for an unknown
// accessory id, so callers can tell "no such accessory" apart from a
// legitimate price (never null once the id is valid).
export function getAccessoryPriceUsd(accessoryId: string, nowMs: number = Date.now()): number | null {
  const acc = getAccessory(accessoryId);
  if (!acc) return null;
  if (!isAccessoryFestivalLive(nowMs)) return acc.costUsd;
  // Round to the nearest cent so the on-chain amount stays a clean 2-decimal
  // USD value, same precision as every other price in this file.
  return Math.round(acc.costUsd * (1 - ACCESSORY_FESTIVAL_DISCOUNT_PERCENT / 100) * 100) / 100;
}

