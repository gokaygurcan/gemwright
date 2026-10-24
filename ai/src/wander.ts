import { HUMAN_BODIES } from './bodies';
import { chaosOf } from './chaos';
import { allServiceLocations, type Landmark, type ServiceType } from './locations';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';

// Chaos on the road (chaos.ts), always with a purpose: a longer walk sometimes goes by way of a
// real place near the line (a shop, the bank, a healer) where the resident looks around a moment,
// and a walker sometimes stops to greet someone it passes. The destination never changes here;
// changing plans is the town routine's business (life.ts).
const stops: ServiceType[] = [
  'banker',
  'healer',
  'alchemist',
  'tailor',
  'blacksmith',
  'jeweler',
  'carpenter',
  'tinker',
  'mage',
  'bowyer',
  'weaponsmith',
  'fisherman',
  'bard',
  'cook',
  'animal-trainer'
];
let places: Landmark[] | undefined;

// A place worth a detour between `from` and `goal`: off the direct line by at most 40% of the
// trip (and 60 tiles), and not right at either end. Chance: half the resident's chaos.
export function detourFor(session: PlayerSession, from: { x: number; y: number }, goal: { x: number; y: number }) {
  const direct = distance(from, goal);
  if (direct < 60 || Math.random() >= chaosOf(session) / 2) return undefined;
  places ??= stops.flatMap((service) => allServiceLocations(service));
  const extra = Math.min(60, direct * 0.4);
  const options = places.filter(
    (p) => distance(from, p) >= 12 && distance(p, goal) >= 12 && distance(from, p) + distance(p, goal) - direct <= extra
  );
  return options[Math.floor(Math.random() * options.length)];
}

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
