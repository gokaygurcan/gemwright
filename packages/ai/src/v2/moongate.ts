import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { moongate } from '@gemwright/common/game/items';
import { moongateList } from '@gemwright/common/game/rules';
import { moongateDestination } from '@gemwright/network/gumps';
import type { PlayerSession } from '@gemwright/network/session';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const refusals = new Set([1019003, 1019002, 1019004, 1005561, 1005564, 1049616, 1071955]);
type Going = () => boolean | Promise<boolean>;

export async function takeMoongate(
  session: PlayerSession,
  leg: { x: number; y: number; to: string },
  walk: (goal: { x: number; y: number; range: number }, going: Going) => Promise<boolean>,
  going: Going
) {
  const target = Object.entries(moongateList).find(([name]) => name === leg.to)?.[1];
  const world = session.world;
  if (!target || world.map !== 1 || !(await going())) return false;
  if (!(await walk({ ...leg, range: 1 }, going))) return false;
  const gate = [...world.entities.values()].find(
    (e) =>
      e.graphic === moongate &&
      e.position &&
      away(e.position, leg) <= 1 &&
      world.position &&
      away(world.position, e.position) <= 1
  );
  if (!gate?.position) return false;
  const old = new Set(world.gumps.values());
  const heard = new Set(world.journal);
  const refused = () => world.journal.some((e) => !heard.has(e) && refusals.has(e.cliloc ?? 0));
  const wait = async (done: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
      if (!(await going()) || refused()) return false;
      if (done()) return true;
    }
    return false;
  };
  if (GHOST_BODIES.has(world.entities.get(world.serial ?? -1)?.graphic ?? 0)) {
    if (
      world.position &&
      away(world.position, gate.position) === 0 &&
      !(await walk({ x: gate.position.x + 2, y: gate.position.y, range: 1 }, going))
    )
      return false;
    if (!(await walk({ ...gate.position, range: 0 }, going))) return false;
  } else session.use(gate.serial);
  const offered = () =>
    [...world.gumps.values()].find(
      (gump) => !old.has(gump) && moongateDestination(gump.layout, target.label) !== undefined
    );
  if (!(await wait(() => !!offered(), 3000))) return false;
  const gump = offered();
  const choice = gump && moongateDestination(gump.layout, target.label);
  if (!gump || choice === undefined || !(await going())) return false;
  session.replyGump(gump.serial, gump.id, 1, [choice]);
  return wait(() => world.map === 1 && !!world.position && away(world.position, target) <= 6, 5000);
}
