import { tally } from './activity';
import { appraise } from './appraise';
import { noteSpoken, quietNow } from './conversation';
import { gossipFor } from './gossip';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import { sharedMemoryLine } from './resident-memory';
import { reportPosition } from './spread';
import type { Checkpoint } from './store';

const RANGE = 12;
const ENCOUNTER_GAP = 5 * 60_000;
const MAX_RELATIONSHIPS = 50;
const lastScan = new WeakMap<Checkpoint, number>();
const lastGreeting = new WeakMap<Checkpoint, number>();
const GREETING_GAP = 2 * 60_000;

// Records encounters with fellow residents (serial -> name from the resident store), at most every
// 30 seconds. An encounter counts once per five minutes apart. Conversation and cooperation adjust
// affinity; telling human players from townsfolk NPCs needs more than a body and notoriety.
// A fresh encounter can bring a greeting, more familiar the more often the two have met; at most
// one greeting per two minutes, with a chance set by the resident's sociability.
const greeting = (name: string, seen: number) =>
  seen <= 1
    ? `Hail, ${name}.`
    : seen < 5
      ? `Good to see thee again, ${name}.`
      : [`Back at it, ${name}?`, `${name}! Busy day?`, `Well met again, ${name}.`][seen % 3];

export function noticePeers(
  session: PlayerSession,
  checkpoint: Checkpoint,
  peers?: ReadonlyMap<number, string>,
  sociability = 0.5
) {
  const now = Date.now();
  if (session.world.serial !== null && session.world.position)
    reportPosition(session.world.serial, session.world.position);
  if (!peers?.size || (lastScan.get(checkpoint) ?? 0) + 30_000 > now) return;
  lastScan.set(checkpoint, now);
  const here = session.world.position;
  if (!here) return;
  for (const mobile of session.world.entities.values()) {
    // The in-game name wins over the roster's proposed name when it has been observed.
    const name = peers.has(mobile.serial) ? (mobile.name ?? peers.get(mobile.serial)) : undefined;
    if (!name || mobile.serial === session.world.serial || !mobile.position) continue;
    if (distance(here, mobile.position) > RANGE) continue;
    const previous = checkpoint.relationships[name];
    const last = previous?.lastSeen ? Date.parse(previous.lastSeen) : 0;
    const seen = (previous?.seen ?? 0) + (now - last >= ENCOUNTER_GAP ? 1 : 0);
    const fresh = seen > (previous?.seen ?? 0);
    if (
      fresh &&
      !quietNow(checkpoint) &&
      (lastGreeting.get(checkpoint) ?? 0) + GREETING_GAP <= now &&
      Math.random() < sociability * 0.6
    ) {
      lastGreeting.set(checkpoint, now);
      try {
        // News first, when there is some (gossip.ts): what this resident saw or was told.
        const news = Math.random() < 0.4 ? gossipFor(session.world.serial ?? 0, mobile.serial) : undefined;
        // Someone it shares a memory with is greeted with it now and then (resident-memory.ts).
        const memory = Math.random() < 0.5 ? sharedMemoryLine(checkpoint, mobile.serial) : undefined;
        const line = memory
          ? `${name.split(' ')[0]}! ${memory}`
          : `${greeting(name, seen) ?? `Hail, ${name}.`}${news ? ` ${news}` : ''}`;
        session.say(line);
        tally(session, 'speech');
        noteSpoken(checkpoint, mobile.serial, name, line, true);
      } catch {
        // Not ready to speak; the encounter is still recorded.
      }
    }
    // Sized up from what it wears, against how it sees itself (appraise.ts).
    const appraisal = appraise(session, mobile, checkpoint.self);
    checkpoint.relationships[name] = {
      affinity: previous?.affinity ?? 0,
      note: `Fellow resident, last seen near ${mobile.position.x},${mobile.position.y}; ${appraisal.opinion}`,
      seen,
      lastSeen: new Date(now).toISOString(),
      peer: true,
      appraisal
    };
  }
  const entries = Object.entries(checkpoint.relationships);
  if (entries.length > MAX_RELATIONSHIPS)
    checkpoint.relationships = Object.fromEntries(
      entries.sort((a, b) => (b[1].lastSeen ?? '').localeCompare(a[1].lastSeen ?? '')).slice(0, MAX_RELATIONSHIPS)
    );
}
