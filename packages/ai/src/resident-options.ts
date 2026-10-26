import type { CharacterTemplate } from './config';
import type { DecisionCoordinator } from './decisions';
import type { RunRecord } from './dungeon-context';
import type { PlayerSession } from './protocol/session';
import type { Checkpoint } from './store';

export interface ResidentOptions {
  session: PlayerSession;
  assets: string;
  template: CharacterTemplate;
  seconds: number;
  overland?: boolean;
  peers?: ReadonlyMap<number, string>;
  label?: string;
  checkpoint: Checkpoint;
  decisions?: DecisionCoordinator;
  save: (checkpoint: Checkpoint) => void;
  recordRun?: (record: RunRecord) => void;
  stopping?: () => boolean;
}
