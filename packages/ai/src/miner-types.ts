import type { createNavigator } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position, WorldView } from './protocol/world';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';

// What the miner's town services work with (miner-services.ts) and what they count.
export interface MinerProgress {
  smelts: number;
  ingotsProduced: number;
  deposits: number;
  trips: number;
  purchases: number;
  sold: number;
  packRejected: boolean;
}

export interface MinerServicesContext {
  session: PlayerSession;
  serial: number;
  terrain: Terrain;
  checkpoint: Checkpoint;
  blocked: Set<string>;
  city: string;
  banks: readonly { x: number; y: number }[];
  shops: readonly { x: number; y: number }[];
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  navigate: ReturnType<typeof createNavigator>;
  carried: (backpack: number) => Entity[];
  smeltable: (backpack: number) => Entity[];
  retainedOre: (backpack: number) => Entity[];
  unsmeltable: Set<number>;
  plan: () => NonNullable<Checkpoint['mining']>;
  newTrip: () => NonNullable<Checkpoint['mining']>;
  progress: MinerProgress;
  persist: () => void;
}
