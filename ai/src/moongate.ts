import { Blocked } from './blocked';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import { moongateDestination } from './protocol/gumps';
import type { PlayerSession } from './protocol/session';
import type { Position } from './protocol/world';
import { reachableFrom } from './unreachable';

// Trammel public moongates on the pinned shard (PublicMoongate.PMList.Trammel): gate location and
// the destination's label in the gate menu. Arrival is at the destination gate itself.
export const moongates = {
  moonglow: { x: 4467, y: 1283, z: 5, label: 1012003 },
  britain: { x: 1336, y: 1997, z: 5, label: 1012004 },
  jhelom: { x: 1499, y: 3771, z: 5, label: 1012005 },
  yew: { x: 771, y: 752, z: 5, label: 1012006 },
  minoc: { x: 2701, y: 692, z: 5, label: 1012007 },
  trinsic: { x: 1828, y: 2948, z: -20, label: 1012008 },
  skara: { x: 643, y: 2067, z: 5, label: 1012009 }
} as const;
export type Gate = keyof typeof moongates;

export const nearestGate = (point: { x: number; y: number }): Gate =>
  (Object.keys(moongates) as Gate[]).sort((a, b) => distance(point, moongates[a]) - distance(point, moongates[b]))[0] ??
  'britain';

// Walks to the nearest public moongate that can be reached on foot and steps through to `to`, as
// any player travels. A gate across water (an island town seen from the shore) is skipped for the
// next nearest; reaching `to`'s own gate on foot means the walk alone arrives.
// Ghost bodies (male, female, elf male, elf female).
const ghosts = new Set([0x192, 0x193, 0x25f, 0x260]);

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
  const here = position();
  const order = (Object.keys(moongates) as Gate[]).sort(
    (a, b) => distance(here, moongates[a]) - distance(here, moongates[b])
  );
  const target = moongates[to];
  let from: Gate | undefined;
  for (const candidate of order) {
    if (!reachableFrom(moongates[candidate], here)) continue;
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
  if (!from) throw new Blocked('unreachable', `No public moongate can be reached on foot from ${here.x},${here.y}`);
  if (from === to) return;
  const item = [...session.world.entities.values()].find(
    (entity) => entity.graphic === 0x0f6c && entity.position && distance(position(), entity.position) <= 1
  );
  if (!item?.position) throw new Error(`The ${from} public moongate is not observed nearby`);
  const self = session.world.serial === null ? undefined : session.world.entities.get(session.world.serial);
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
  await session.waitFor(() => distance(position(), target) <= 2 && session.world.map === 1, `arrival at ${to}`);
  phase('moongate-arrival', `Arrived through the ${to} moongate`);
}
