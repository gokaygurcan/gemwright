import type { CharacterTemplate } from './config';
import type { DecisionCoordinator } from './decisions';
import type { Thread } from './dialogue';
import type { PlayerSession } from './protocol/session';
import type { JournalEntry } from './protocol/world';
import type { Checkpoint } from './store';

export type Options = {
  persist?: () => void;
  session: PlayerSession;
  checkpoint: Checkpoint;
  template: CharacterTemplate;
  city: string;
  peers?: ReadonlyMap<number, string>;
  decisions?: DecisionCoordinator;
};
export interface Listener {
  options: Options;
  threads: Map<number, Thread>;
  handled: WeakSet<JournalEntry>;
  // First names heard in speech or on the roster, to tell when a line is meant for someone else.
  known: Set<string>;
  busy: boolean;
  lastSpoke: number;
  // After a conversation ends the resident pauses talking to anyone, requests aside.
  quietUntil: number;
  timer: ReturnType<typeof setInterval>;
}
