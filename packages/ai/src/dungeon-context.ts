import type { CharacterTemplate } from './config';
import type { createNavigator } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Position } from './protocol/world';
import type { Checkpoint, DungeonRunRecord } from './store';
import type { Terrain } from './terrain';

// What the dungeon code needs from a character, whatever its profession. Fighters (fighter-dungeon.ts)
// and the tamer, bard and thief (profession-dungeon.ts) each supply one; `work` is the role's own
// step in a room: fight, send the pet, play, or steal.
export type DungeonRun = NonNullable<Checkpoint['dungeon']>;
export type RunRecord = Omit<DungeonRunRecord, 'id' | 'residentId' | 'name'>;

export interface DungeonContext {
  session: PlayerSession;
  serial: number;
  terrain: Terrain;
  template: CharacterTemplate;
  checkpoint: Checkpoint;
  deadline: number;
  home: { x: number; y: number };
  position: () => Position;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  persist: () => void;
  // Overland travel (mounted for fighters).
  navigate: ReturnType<typeof createNavigator>;
  dead: () => boolean;
  // Fighters recover their own corpses (fighter-recovery.ts); professions use dungeon-death.ts.
  recoversOwnCorpse: boolean;
  // A ghost on its way out or waiting for a party healer is not a death to react to.
  setRecovering: (on: boolean) => void;
  townNeed: () => { reason: string; hard: boolean } | null;
  // One step of the role's work against creatures within `radius`; true when it acted.
  work: (radius: number, run: DungeonRun) => Promise<boolean>;
  // Puts recovered equipment back on after a corpse is emptied.
  dress: () => Promise<void>;
  // Called once a run has ended (a fighter heads to town to sell and bank).
  afterRun: () => void;
  record?: (record: RunRecord) => void;
}
