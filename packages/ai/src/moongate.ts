import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { moongate } from '@gemwright/common/game/items';
import { moongateDestination } from '@gemwright/network/gumps';
import type { PlayerSession } from '@gemwright/network/session';
import type { Position } from '@gemwright/network/world';

import { areaHere, gateArea, strandedAt } from './areas';
import { Blocked } from './blocked';
import { dangerAhead } from './danger-response';
import { type Gate, moongates } from './gates';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import { gatherPets } from './pets';
import { recallFor } from './recall';
import { noteStranded, strandedOften, useStuckMenu } from './stuck';
import { placeAllowed } from './towns';
import { reachableFrom } from './unreachable';

const ghosts = GHOST_BODIES;

// Walks to the nearest public moongate that can be reached on foot and steps through to `to`, as
// any player travels. A gate across water (an island town seen from the shore) is skipped for the
// next nearest; reaching `to`'s own gate on foot means the walk alone arrives.
export async function travelByMoongate(
  ctx: {
    session: PlayerSession;
    position: () => Position;
    navigate: ReturnType<typeof createNavigator>;
    phase: (phase: string, note: string) => void;
  },
  to: Gate
) {
  const { session, position, navigate, phase } = ctx;
  // Never through to a city the shard keeps its residents out of (gemwright.json ai.cities).
  if (!placeAllowed(moongates[to]))
    throw new Blocked('unreachable', `The ${to} moongate leads out of the allowed cities`);
  const here = position();
  const order = (Object.keys(moongates) as Gate[]).sort(
    (a, b) => distance(here, moongates[a]) - distance(here, moongates[b])
  );
  const target = moongates[to];
  let from: Gate | undefined;
  // A gate within walking range first: walking to a far one crosses the wilds (and its monsters).
  // Stranded farther out (a desert, a far mine), the nearest gates it can walk to, however far.
  // Only gates in its own walkable area (areas.ts); none at all means walking out is impossible.
  const own = order.filter((gate) => {
    const area = areaHere(here);
    return area === undefined || gateArea(moongates[gate]) === area;
  });
  const near = own.filter((gate) => distance(here, moongates[gate]) <= 500);
  // Standing in a pocket the area catalogue knows nothing of (areas.ts locates one by walking to a
  // known place, and a pocket caches as -1) leaves no own gates at all: the nearest gates on the map
  // are still worth walking to, or the resident could never leave the wilds it woke up in.
  const candidates = near.length ? near : own.length ? own.slice(0, 3) : order.slice(0, 3);
  let dangerVetoed = 0;
  // Route memory is another resident's hint, not proof for this one: the nearest gate it can reach
  // is always tried once, and only later candidates respect the shared "lately unreachable" list.
  let fresh = true;
  for (const candidate of candidates) {
    if (!fresh && !reachableFrom(moongates[candidate], here)) continue;
    if (dangerAhead(session, here, moongates[candidate])) {
      dangerVetoed++;
      continue;
    }
    fresh = false;
    phase('moongate-travel', `Walking to the ${candidate} moongate to travel to ${to}`);
    try {
      await navigate(moongates[candidate], 1);
    } catch (error) {
      if (error instanceof Blocked && error.reason === 'unreachable') continue;
      throw error;
    }
    from = candidate;
    break;
  }
  // Stranded with a marked rune anywhere: recall to it, as a player would (recall.ts).
  if (!from && (await recallFor(session)?.(target, 10_000))) return;
  // Every road vetoed as watched: one attempt at the nearest gate anyway. The walk watches threats
  // as it goes and turns back on its own; staying put is what gets a walker killed.
  const nearest = candidates[0];
  if (!from && nearest && dangerVetoed > 0 && dangerVetoed >= candidates.length) {
    phase('moongate-travel', `Every road to a moongate is watched; trying the ${nearest} gate anyway`);
    try {
      await navigate(moongates[nearest], 1);
      from = nearest;
    } catch (error) {
      if (!(error instanceof Blocked && error.reason === 'unreachable')) throw error;
    }
  }
  if (!from) noteStranded(session);
  // In an area with no moongate it is stranded for sure: help at once, not after three tries.
  if (
    !from &&
    (strandedAt(here) || strandedOften(session)) &&
    (await useStuckMenu({ session, phase, log: (m) => phase('stuck', m) }, to, 'no moongate within reach'))
  )
    return;
  if (!from && dangerVetoed >= candidates.length)
    throw new Blocked(
      'dangerous',
      `Monsters watch every road to a moongate from ${here.x},${here.y}; waiting for the roads to clear`
    );
  if (!from) throw new Blocked('unreachable', `No public moongate can be reached on foot from ${here.x},${here.y}`);
  if (from === to) return;
  const item = [...session.world.entities.values()].find(
    (entity) => entity.graphic === moongate && entity.position && distance(position(), entity.position) <= 1
  );
  if (!item?.position) throw new Blocked('unreachable', `The ${from} public moongate is not observed nearby`);
  const self = session.world.serial === null ? undefined : session.world.entities.get(session.world.serial);
  // Pets go along only with a living master standing next to them.
  if (!(self && ghosts.has(self.graphic))) await gatherPets(session, position, navigate, phase, moongates[from]);
  if (self && ghosts.has(self.graphic)) {
    // A ghost cannot double-click ("I am dead and cannot do that"); walking onto the gate opens
    // the same menu (PublicMoongate.OnMoveOver), so step off it first if already standing there.
    const gate = item.position;
    if (position().x === gate.x && position().y === gate.y) await navigate({ x: gate.x + 2, y: gate.y }, 1);
    await navigate(gate, 0);
  } else session.use(item.serial);
  const offered = () =>
    [...session.world.gumps.values()].find((gump) => moongateDestination(gump.layout, target.label) !== undefined);
  await session.waitFor(() => !!offered(), 'public moongate destinations');
  const gump = offered();
  const choice = gump && moongateDestination(gump.layout, target.label);
  if (!gump || choice === undefined) throw new Error(`${to} was not offered on the Trammel moongate page`);
  session.replyGump(gump.serial, gump.id, 1, [choice]);
  // The far gate sets one down beside it, not always on the catalogued tile.
  try {
    await session.waitFor(() => distance(position(), target) <= 6 && session.world.map === 1, `arrival at ${to}`);
  } catch {
    throw new Blocked('unreachable', `The ${from} moongate did not take me to ${to}`);
  }
  phase('moongate-arrival', `Arrived through the ${to} moongate`);
}
