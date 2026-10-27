import { HUMAN_BODIES } from '@gemwright/common/bodies';

import { canPause } from './action-purpose';
import type { PlayerSession } from './protocol/session';

// Human timing on the road (navigation.ts): people walk, not run, through a crowd or when leading
// someone; they stop now and then for a few seconds; they react a moment late to danger; and once
// in a long while they take a wrong step. Never when fleeing or fighting, and never so often that
// the route itself changes.
const escorting = new WeakSet<PlayerSession>();
export const setEscorting = (session: PlayerSession, on: boolean) =>
  on ? escorting.add(session) : escorting.delete(session);

export function walkingPace(session: PlayerSession) {
  if (escorting.has(session)) return true;
  const here = session.world.position;
  if (!here) return false;
  let people = 0;
  for (const m of session.world.entities.values())
    if (
      m.kind === 'mobile' &&
      m.serial !== session.world.serial &&
      HUMAN_BODIES.has(m.graphic) &&
      m.position &&
      Math.max(Math.abs(m.position.x - here.x), Math.abs(m.position.y - here.y)) <= 5 &&
      ++people >= 4
    )
      return true;
  return false;
}

// A short stop on the way, about once in 300 steps: 2 to 6 seconds.
export function pauseFor(session: PlayerSession, urgent: boolean) {
  if (urgent || !canPause(session) || Math.random() >= 1 / 300) return 0;
  return 2000 + Math.random() * 4000;
}

// A wrong step about once in 500: the direction one turn off.
export function slip(direction: number, urgent: boolean) {
  if (urgent || Math.random() >= 1 / 500) return direction;
  return (direction + (Math.random() < 0.5 ? 1 : 7)) % 8;
}

// How long a person takes to react to danger: a third of a second to a second.
export const reactionDelay = () => 330 + Math.random() * 670;
