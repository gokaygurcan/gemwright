import { HUMAN_BODIES } from '@gemwright/common/game/bodies';
import type { PlayerSession } from '@gemwright/network/session';

import { chaosOf } from './chaos';
import { distance } from './navigation';

// Chaos on the road (chaos.ts), always with a purpose: a walker sometimes stops to greet someone
// it passes. The destination never changes here; changing plans is the town routine's business
// (life.ts).
const humans = HUMAN_BODIES;
const greetings = ['hail', 'hi', 'o/', 'hey', 'well met'];
const greeted = new WeakMap<PlayerSession, Set<number>>();

// Now and then, someone within four tiles gets a passing greeting and a short pause (a quarter of
// the resident's chaos per check); nobody is greeted twice in one session.
export async function passingGreeting(session: PlayerSession) {
  if (Math.random() >= chaosOf(session) / 4) return;
  const here = session.world.position;
  if (!here) return;
  const done = greeted.get(session) ?? new Set<number>();
  greeted.set(session, done);
  const someone = [...session.world.entities.values()].find(
    (m) =>
      m.kind === 'mobile' &&
      m.serial !== session.world.serial &&
      humans.has(m.graphic) &&
      m.notoriety !== 7 &&
      !done.has(m.serial) &&
      !!m.position &&
      distance(here, m.position) <= 4
  );
  if (!someone) return;
  done.add(someone.serial);
  await Bun.sleep(400 + Math.random() * 800);
  session.say(greetings[Math.floor(Math.random() * greetings.length)] ?? 'hail');
  await Bun.sleep(1500 + Math.random() * 2500);
}
