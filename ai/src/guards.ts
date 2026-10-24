import { GHOST_BODIES, HUMAN_ELF_BODIES } from './bodies';
import { allServiceLocations } from './locations';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';

// Residents call the guards on criminals and murderers in guarded towns, as players do: saying
// "guards" (speech keyword 0x0007) inside a guarded region makes ServUO's GuardedRegion.CallGuards
// send a guard for every criminal (grey, notoriety 4) and murderer (red, 6) within fourteen tiles.
// Whether the character stands in a guarded town comes from what the server said last: "You are
// now under the protection of the town guards" (500112) or "You have left..." (500113); with
// neither heard yet, being near a town's bank counts. A resident only calls while alive and not
// grey or red itself, at most once a minute per offender, and not every bystander shouts.
const UNDER = 500112;
const LEFT = 500113;
const TICK_MS = 3000;
const CALL_RANGE = 12;
const PER_OFFENDER_MS = 60_000;
const ghosts = GHOST_BODIES;
const humans = HUMAN_ELF_BODIES;
const banks = allServiceLocations('banker');
const watching = new WeakSet<PlayerSession>();

export function guarded(session: PlayerSession): boolean {
  for (let i = session.world.journal.length - 1; i >= 0; i--) {
    const cliloc = session.world.journal[i]?.cliloc;
    if (cliloc === UNDER) return true;
    if (cliloc === LEFT) return false;
  }
  const here = session.world.position;
  return !!here && banks.some((bank) => distance(here, bank) <= 40);
}

// Starts the watch for a session once; it ends when the session does. `boldness` (0..1) is the
// chance this resident is one who shouts rather than looks away.
export function watchForGuards(session: PlayerSession, boldness: number, log: (message: string) => void) {
  if (watching.has(session)) return;
  watching.add(session);
  const called = new Map<number, number>();
  const timer = setInterval(() => {
    if (session.phase === 'offline' || session.phase === 'failed') {
      clearInterval(timer);
      return;
    }
    if (session.phase !== 'ready') return;
    const serial = session.world.serial;
    const self = serial === null ? undefined : session.world.entities.get(serial);
    const here = session.world.position;
    if (!self || !here || ghosts.has(self.graphic) || [4, 6].includes(self.notoriety ?? 0)) return;
    if (!guarded(session)) return;
    const now = Date.now();
    const offender = [...session.world.entities.values()].find(
      (m) =>
        m.kind === 'mobile' &&
        m.serial !== serial &&
        humans.has(m.graphic) &&
        [4, 6].includes(m.notoriety ?? 0) &&
        !!m.position &&
        distance(here, m.position) <= CALL_RANGE &&
        now - (called.get(m.serial) ?? 0) > PER_OFFENDER_MS
    );
    if (!offender) return;
    called.set(offender.serial, now);
    if (Math.random() > boldness) return;
    try {
      session.say('guards');
      log(`Called the guards on ${offender.name ?? 'a'} ${offender.notoriety === 6 ? 'murderer' : 'criminal'}`);
    } catch {
      // A shout that could not be sent is one nobody heard.
    }
  }, TICK_MS);
}
