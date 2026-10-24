import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Position } from './protocol/world';

// The animals a character owns and expects to travel with, by source (a pack animal, an unridden
// horse, a tamer's companion). Each owner registers a function reading its own memory, so the list
// is always current. A public moongate takes along only pets within 3 tiles of their master
// (BaseCreature.TeleportPets), so travellers gather them first.
const sources = new WeakMap<PlayerSession, Map<string, () => number[]>>();

export function petSource(session: PlayerSession, name: string, pets: () => number[]) {
  const named = sources.get(session) ?? new Map<string, () => number[]>();
  named.set(name, pets);
  sources.set(session, named);
}

const ownedPets = (session: PlayerSession) =>
  [...(sources.get(session)?.values() ?? [])].flatMap((pets) => pets()).filter((s) => !session.world.deaths.has(s));

// Calls the pets and waits until every one stands within 2 tiles of the gate; a pet still in sight
// but stuck behind is fetched (walk to it, call it, walk back) and waited for again. Only a pet
// gone from sight entirely is left, and that is reported.
export async function gatherPets(
  session: PlayerSession,
  position: () => Position,
  navigate: (point: { x: number; y: number; z?: number }, range: number) => Promise<unknown>,
  phase: (phase: string, note: string) => void,
  gate: { x: number; y: number; z: number }
) {
  const behind = () =>
    ownedPets(session).filter((serial) => {
      const pet = session.world.entities.get(serial);
      return !pet?.position || distance(position(), pet.position) > 2;
    });
  const call = async () => {
    session.say('all follow me');
    await session.waitFor(() => !behind().length, 'pets gathered', 20_000).catch(() => {});
  };
  if (!behind().length) return true;
  phase('gathering-pets', 'Waiting for my animals before stepping through the moongate');
  await call();
  for (let fetch = 0; fetch < 2 && behind().length; fetch++) {
    const pet = behind()
      .map((serial) => session.world.entities.get(serial)?.position)
      .find((at) => at !== undefined);
    if (!pet) break;
    phase('gathering-pets', 'Fetching an animal that fell behind');
    await navigate(pet, 1).catch(() => {});
    session.say('all follow me');
    await navigate(gate, 1).catch(() => {});
    await call();
  }
  if (!behind().length) return true;
  phase('gathering-pets', `${behind().length} animal(s) out of sight; going through without them`);
  return false;
}
