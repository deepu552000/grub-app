// lib/pet-accessories-state.ts
//
// Unlock/equip/remove logic for accessories. Pure functions, no UI, no
// rendering — this just tracks what's unlocked and what's equipped per
// slot. Designed to slot into your existing PetState as one new field.

import { ACCESSORIES, getAccessory, type AccessorySlot } from "./accessories";

export type AccessoryState = {
  unlocked: string[]; // accessory ids the player has paid Glimmer to unlock
  equipped: Partial<Record<AccessorySlot, string>>; // slot -> accessory id
};

export function createEmptyAccessoryState(): AccessoryState {
  return { unlocked: [], equipped: {} };
}

export function isUnlocked(state: AccessoryState, accessoryId: string): boolean {
  return state.unlocked.includes(accessoryId);
}

export function isEquipped(state: AccessoryState, accessoryId: string): boolean {
  const acc = getAccessory(accessoryId);
  if (!acc) return false;
  return state.equipped[acc.slot] === accessoryId;
}

// Payment is now handled outside (ETH on Base) — this function just records
// the unlock after a successful payment. No Glimmer deducted.
export function unlockAccessory(
  state: AccessoryState,
  accessoryId: string,
): { ok: true; newState: AccessoryState } | { ok: false; reason: string } {
  const acc = getAccessory(accessoryId);
  if (!acc) return { ok: false, reason: "Unknown accessory" };
  if (isUnlocked(state, accessoryId)) return { ok: false, reason: "Already unlocked" };

  return {
    ok: true,
    newState: { ...state, unlocked: [...state.unlocked, accessoryId] },
  };
}

// Equipping a new item in a slot automatically swaps out whatever was
// there before in that same slot (e.g. equipping black glasses while gold
// is equipped removes gold — both are "face" slot).
export function equipAccessory(
  state: AccessoryState,
  accessoryId: string,
): { ok: true; newState: AccessoryState } | { ok: false; reason: string } {
  const acc = getAccessory(accessoryId);
  if (!acc) return { ok: false, reason: "Unknown accessory" };
  if (!isUnlocked(state, accessoryId)) return { ok: false, reason: "Not unlocked yet" };

  return {
    ok: true,
    newState: {
      ...state,
      equipped: { ...state.equipped, [acc.slot]: accessoryId },
    },
  };
}

// Removing clears that slot — cat returns to normal, no accessory shows there.
export function removeAccessory(state: AccessoryState, slot: AccessorySlot): AccessoryState {
  const newEquipped = { ...state.equipped };
  delete newEquipped[slot];
  return { ...state, equipped: newEquipped };
}

export function getEquippedList(state: AccessoryState): string[] {
  return Object.values(state.equipped).filter(Boolean) as string[];
}
