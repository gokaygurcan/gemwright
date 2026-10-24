import type { createNavigator } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Position, WorldView } from './protocol/world';
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
export const horseBodies = new Set([0xc8, 0xe2, 0xe4, 0xcc]);
export const mountEquipment = (world: WorldView) =>
  world.serial === null
    ? undefined
    : world.childrenOf(world.serial).find((item) => item.kind === 'item' && item.layer === Layer.Mount);
export function canAffordMount(price: number, gold: number, reserve: number): boolean {
  return Number.isSafeInteger(price) && price > 0 && price <= 750 && gold >= price + reserve;
}
