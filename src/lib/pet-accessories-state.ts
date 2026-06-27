// lib/pet-accessories-state.ts
//
// Unlock/equip/remove logic for accessories across all stages.
// Pure functions, no UI, no rendering.
//
// Slots by stage:
//   Stage 1: "head" | "face"
//   Stage 2: "crown" | "cape" | "wand"
//   (Stage 3/4 slots to be added later — same pattern)

import { ACCESSORIES, getAccessory, canEquipForStage, type AccessorySlot } from "./accessories";

export type AccessoryState = {
  unlocked: string[];                              // accessory ids the player has paid to unlock
  equipped: Partial<Record<AccessorySlot, string>>; // slot -> accessory id currently equipped
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

// Records unlock after a successful payment (ETH/USDC on Base).
// No in-game currency deducted — payment is handled externally.
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

// Equip an accessory. Requires:
//  1. The accessory is unlocked.
//  2. The cat is currently at the matching stage (currentCatStage must match accessory.stage).
// Equipping into a slot auto-removes whatever was there before.
export function equipAccessory(
  state: AccessoryState,
  accessoryId: string,
  currentCatStage: number,
): { ok: true; newState: AccessoryState } | { ok: false; reason: string } {
  const acc = getAccessory(accessoryId);
  if (!acc) return { ok: false, reason: "Unknown accessory" };
  if (!isUnlocked(state, accessoryId)) return { ok: false, reason: "Not unlocked yet" };
  if (!canEquipForStage(currentCatStage, acc.stage)) {
    return {
      ok: false,
      reason: `This accessory is for Stage ${acc.stage} cats. Your cat is Stage ${currentCatStage}.`,
    };
  }

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

// Returns only the equipped accessories that belong to a specific stage.
// Used to filter which accessories are visible on the cat at render time.
export function getEquippedForStage(state: AccessoryState, stage: number): string[] {
  return getEquippedList(state).filter((id) => {
    const acc = getAccessory(id);
    return acc?.stage === stage;
  });
}
