// lib/accessories.ts
//
// Accessory catalog + positioning for ALL stages.
//
// Stage 1 slots: "head" | "face"   (bow, glasses)
// Stage 2 slots: "crown" | "cape" | "wand"  (crown, cape, magic wand)
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
  | "necklace"
  | "halo";

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

// ── All accessories combined ─────────────────────────────────────────────────
export const ACCESSORIES: Accessory[] = [
  ...STAGE1_ACCESSORIES,
  ...STAGE2_ACCESSORIES,
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
  "wand-star":    { top: 88, left: 88, width: 32, rotate: -25 },
  "wand-moon":    { top: 88, left: 88, width: 32, rotate: -25 },
};

const ALL_POSITIONS: Record<string, AccessoryPosition> = {
  ...STAGE1_POSITIONS,
  ...STAGE2_POSITIONS,
};

export function getPosition(accessoryId: string): AccessoryPosition | null {
  return ALL_POSITIONS[accessoryId] ?? null;
}

// ── Guard: which stage+mood combos allow accessory rendering ─────────────────
// Only the "plain" content/smug image for each stage supports accessories.
// Hungry (a), feral (b), sleepy (c) variants use different art — never overlay.
export function accessoriesAllowedFor(stage: number, mood: string): boolean {
  if (mood !== "content" && mood !== "smug") return false;
  return stage === 1 || stage === 2; // expand to 3/4 when those stages are added
}

// Which stage's accessories can be EQUIPPED right now (cat must be at that stage).
// Users can browse/buy any stage from the closet, but equip is blocked unless
// their cat is currently at the matching stage.
export function canEquipForStage(currentCatStage: number, accessoryStage: number): boolean {
  return currentCatStage === accessoryStage;
}
