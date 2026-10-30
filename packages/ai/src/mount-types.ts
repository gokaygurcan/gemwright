import { HORSE_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import type { Position, WorldView } from '@gemwright/network/world';

import type { createNavigator } from './navigation';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';

export interface MountMemory {
  schemaVersion: 1;
  state: 'seeking' | 'purchase-pending' | 'owned' | 'riding' | 'missing' | 'lost';
  horse?: number;
  equipment?: number;
  lastSeen?: { map: number; x: number; y: number; z: number };
  pending?: {
    vendor: number;
    stock: number;
    price: number;
    at: number;
    map: number;
    x: number;
    y: number;
    z: number;
    before: number[];
  };
  retryAfter?: number;
  // Next time a missing horse may be asked for at the stable.
  claimAt?: number;
  // Personal history: a trainer can only ever have an animal this resident left at a stable (or one
  // the shard stabled on logout). Without it the animal is lost in the world, and asking is a walk
  // for nothing. `asked` remembers the answer so a pointless ask is not repeated.
  stabled?: { at: number; city: string };
  asked?: { at: number; answer: 'claimed' | 'none' | 'too-many' | 'silent' };
  note?: string;
}
export interface MountContext {
  session: PlayerSession;
  checkpoint: Checkpoint;
  serial: number;
  terrain: Terrain;
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  check: () => void;
  navigate: ReturnType<typeof createNavigator>;
  phase: (phase: string, note: string) => void;
  log: (note: string) => void;
  persist: () => void;
  backpack: () => number;
  safeToRecover?: (point: { x: number; y: number }) => boolean;
}
export const mountEquipment = (world: WorldView) =>
  world.serial === null
    ? undefined
    : world.childrenOf(world.serial).find((item) => item.kind === 'item' && item.layer === Layer.Mount);
export function canAffordMount(price: number, gold: number, reserve: number): boolean {
  return Number.isSafeInteger(price) && price > 0 && price <= 750 && gold >= price + reserve;
}

// Kept for the mount code: the rideable bodies live with the other body sets.
export const horseBodies = HORSE_BODIES;
