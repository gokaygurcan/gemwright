import { recordEvent } from './gossip';
import { lasting } from './lasting';
import { serviceLocations, townAt } from './locations';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, JournalEntry } from './protocol/world-types';

// Calling out a red player, as players did: a resident who sees a murderer (notoriety 6) in human
// shape shouts where it is, and in town calls the guards ("guards" is a ServUO speech keyword).
// One shout per murderer from anyone nearby every two minutes, so the street does not echo.
// Residents who hear a call keep away from the caller's area for twenty minutes, as they do from
// monsters they saw themselves (danger.ts).
const HEARD_MS = 20 * 60_000;
const CALL = /\bred\b.*\b(at|near|by|in)\b|\bpk\b.*\b(at|near|in)\b|\bguards\b/i;
const lastRead = new WeakMap<PlayerSession, JournalEntry>();
const calls = lasting('red-call');

const lines = (place: string) => [
  `RED AT ${place.toUpperCase()}!!`,
  `red near ${place}! run`,
  `pk at ${place}!!`,
  `RED ${place.toUpperCase()} careful`
];

export function callOutReds(session: PlayerSession, threats: Entity[], human: (mobile: Entity) => boolean) {
  const here = session.world.position;
  if (!here) return;
  for (const red of threats) {
    if (red.notoriety !== 6 || !human(red) || !red.position || calls.active(red.serial)) continue;
    calls.set(red.serial, Date.now() + 2 * 60_000);
    const town = townAt(red.position, '');
    const inTown = !!town && serviceLocations(town, 'banker').some((bank) => distance(bank, red.position ?? here) < 60);
    const options = lines(town || 'the road');
    session.say(inTown ? 'GUARDS!!' : (options[Math.floor(Math.random() * options.length)] ?? 'RED!!'));
    const who = red.name ?? 'a red';
    recordEvent(red.serial, (place) => `saw ${who}, a red, ${place}. watch yourself`, red.position);
    break;
  }
}

// Calls heard since the last look: each marks the caller's area as dangerous in `seen`.
export function hearCalls(
  session: PlayerSession,
  seen: { set: (key: string, until: number) => void },
  cell: (p: { x: number; y: number }) => string
) {
  const journal = session.world.journal;
  const marker = lastRead.get(session);
  const at = marker ? journal.lastIndexOf(marker) : journal.length - 1;
  const last = journal.at(-1);
  if (last) lastRead.set(session, last);
  for (const entry of journal.slice(at + 1)) {
    if (entry.serial === session.world.serial || entry.type !== 0 || !CALL.test(entry.text ?? '')) continue;
    const caller = session.world.entities.get(entry.serial)?.position;
    if (caller) seen.set(cell(caller), Date.now() + HEARD_MS);
  }
}
