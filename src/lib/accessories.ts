// lib/accessories.ts
//
// Accessory catalog + positioning, scoped to stage 1 only, and only for
// the "normal" cat image (the plain stage1.webp — used for both "content"
// and "smug" moods, since they share that file). Hidden for hungry, feral,
// and sleepy, since those moods use different image files (stage1a.webp,
// stage1b.webp) that this art was never fit against.
//
// Positions are percentages of the .kitty-wrap box, which is exactly
// 168x168px at stage 1 (see globals.css --kitty-size). Using percentages
// (not raw px) means this still works if --kitty-size ever changes.
//
// top/left = the CENTER point of the accessory (matches the
// translate(-50%, -50%) used when rendering, so the numbers below are
// "where the middle of the accessory sits", not its top-left corner).

export type AccessorySlot = "head" | "face";

export type Accessory = {
  id: string;
  name: string;
  slot: AccessorySlot;
  cost: number; // Glimmer cost to unlock
  imageUrl: string;
};

export const ACCESSORIES: Accessory[] = [
  {
    id: "bow-black",
    name: "Black Bow",
    slot: "head",
    cost: 8, // TESTING PRICE — was 50. Glimmer caps at 48 and feed already
    // costs 8/use, so 50-75 was literally unaffordable. Real pricing
    // (likely a one-time ETH micro-fee, per your plan) comes later —
    // this flat 8 just unblocks testing for now.
    imageUrl: "/accessories/bow-black.webp",
  },
  {
    id: "bow-red",
    name: "Red Bow",
    slot: "head",
    cost: 8, // TESTING PRICE — see note above
    imageUrl: "/accessories/bow-red.webp",
  },
  {
    id: "party-hat-pink",
    name: "Pink Party Hat",
    slot: "head",
    cost: 8, // TESTING PRICE — see note above
    imageUrl: "/accessories/party-hat-pink.webp",
  },
  {
    id: "party-hat-blue",
    name: "Blue Party Hat",
    slot: "head",
    cost: 8, // TESTING PRICE — see note above
    imageUrl: "/accessories/party-hat-blue.webp",
  },
  {
    id: "glasses-gold",
    name: "Gold Glasses",
    slot: "face",
    cost: 8, // TESTING PRICE — see note above
    imageUrl: "/accessories/glasses-gold.webp",
  },
  {
    id: "glasses-black",
    name: "Black Glasses",
    slot: "face",
    cost: 8, // TESTING PRICE — see note above
    imageUrl: "/accessories/glasses-black.webp",
  },
];

export function getAccessory(id: string): Accessory | undefined {
  return ACCESSORIES.find((a) => a.id === id);
}

export type AccessoryPosition = {
  top: number; // % of kitty-wrap height, center point
  left: number; // % of kitty-wrap width, center point
  width: number; // % of kitty-wrap width
};

// Verified by compositing onto the real stage1.webp and checking visually.
// Both party hat colors share the same fit (only color differs).
// Both glasses pairs share the same fit (same round-frame shape).
export const POSITIONS: Record<string, AccessoryPosition> = {
  "bow-black": { top: 24, left: 50, width: 30 },
  "bow-red": { top: 24, left: 50, width: 30 },
  "party-hat-pink": { top: 12, left: 50, width: 40 },
  "party-hat-blue": { top: 12, left: 50, width: 40 },
  "glasses-gold": { top: 45, left: 50, width: 58 },
  "glasses-black": { top: 45, left: 50, width: 58 },
};

export function getPosition(accessoryId: string): AccessoryPosition | null {
  return POSITIONS[accessoryId] ?? null;
}

// The single source of truth for "is this image the one accessories are
// allowed to render on". Matches catImageSrc(1, "content") /
// catImageSrc(1, "smug") in page.tsx — both resolve to "/cats/stage1.webp"
// with no suffix.
export function accessoriesAllowedFor(stage: number, mood: string): boolean {
  return stage === 1 && (mood === "content" || mood === "smug");
}
