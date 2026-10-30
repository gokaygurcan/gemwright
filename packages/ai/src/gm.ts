import type { PlayerSession } from '@gemwright/network/session';

import { Blocked } from './blocked';
import type { Checkpoint } from './store';

// Verbal utility commands for a game master: GEMWRIGHT::STOP, CONTINUE, STATUS, WHY. They are not
// conversation — no resident discusses them, ever — and they are held to a staff speaker: see
// conversation.ts, which accepts them only from a mobile that is a player (the context menu offers
// party entries, never a vendor's business entries) and whose notoriety is Invulnerable. Ordinary
// players cannot be invulnerable and vendors are not players, so neither can give the order.
export const UTILITY_PREFIX = 'GEMWRIGHT::';
export type Utility = 'STOP' | 'CONTINUE' | 'STATUS' | 'WHY';

export function parseUtility(text: string): Utility | undefined {
  const match = new RegExp(`^\\s*${UTILITY_PREFIX}(STOP|CONTINUE|RESUME|STATUS|WHY)\\s*$`, 'i').exec(text);
  if (!match) return;
  const word = (match[1] ?? '').toUpperCase();
  return (word === 'RESUME' ? 'CONTINUE' : word) as Utility;
}

// A halt is a reason, not a failure: it reports itself as a blocked step so every loop yields, and
// the goal layer is intercepted before it starts another turn.
export class Halted extends Blocked {
  constructor() {
    super('halted', 'Halted by a game master (GEMWRIGHT::CONTINUE to resume)');
    this.name = 'Halted';
  }
}

const checkpoints = new WeakMap<PlayerSession, Checkpoint>();
const holds = new WeakMap<PlayerSession, { by: number; name?: string }>();

// Every runner registers its resident's checkpoint once, so a halt can be read (and resumed) from
// places that only have the session — navigation, the fighter's safety check, the listener.
export function registerCheckpoint(session: PlayerSession, checkpoint: Checkpoint) {
  checkpoints.set(session, checkpoint);
}

export function halt(session: PlayerSession, speaker: { serial: number; name?: string }) {
  const hold = { by: speaker.serial, name: speaker.name };
  holds.set(session, hold);
  const checkpoint = checkpoints.get(session);
  if (checkpoint) checkpoint.halt = { at: Date.now(), ...hold };
}

export function release(session: PlayerSession) {
  holds.delete(session);
  const checkpoint = checkpoints.get(session);
  if (checkpoint) delete checkpoint.halt;
}

// Whether the resident is held. The hold ends by itself when the staff member who gave it is no
// longer in the resident's view ("until I say otherwise, or leave the view"), and that clearing is
// written back to the checkpoint so a relog does not resurrect it.
export function halted(session: PlayerSession): boolean {
  let hold = holds.get(session);
  const checkpoint = checkpoints.get(session);
  if (!hold && checkpoint?.halt) {
    hold = { by: checkpoint.halt.by, name: checkpoint.halt.name };
    holds.set(session, hold);
  }
  if (!hold) return false;
  if (session.world.entities.has(hold.by)) return true;
  holds.delete(session);
  if (checkpoint?.halt) delete checkpoint.halt;
  return false;
}

export function assertNotHalted(session: PlayerSession) {
  if (halted(session)) throw new Halted();
}

// A short, honest answer to GEMWRIGHT::STATUS and GEMWRIGHT::WHY.
export function statusLine(session: PlayerSession): string {
  const checkpoint = checkpoints.get(session);
  if (!checkpoint) return 'I do not know my own state yet.';
  const goal = checkpoint.goal as { kind?: string; phase?: string; note?: string } | null | undefined;
  const held = halted(session) ? ' (halted)' : '';
  const doing = goal?.kind ? `${goal.kind}${goal.phase ? `/${goal.phase}` : ''}` : 'no goal';
  return `${doing}: ${goal?.note ?? '—'}${held}`;
}

export function whyLine(session: PlayerSession): string {
  const checkpoint = checkpoints.get(session);
  if (!checkpoint) return 'I do not know my own state yet.';
  const failures = Object.entries(checkpoint.objectives ?? {}).sort((a, b) => b[1].until - a[1].until);
  if (!failures.length) return 'Nothing has blocked me recently.';
  const latest = failures[0];
  if (!latest) return 'Nothing has blocked me recently.';
  return `Last block: ${latest[0]} — ${latest[1].reason}`;
}
