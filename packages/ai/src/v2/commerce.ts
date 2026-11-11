import { buys, isA } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { foreseeTrade, harvestBy, tools } from './knowledge';
import type { Mind } from './mind';
import type { Option, Step } from './options';

export function sales(
  mind: Mind,
  session: PlayerSession,
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[],
  bankers: readonly { x: number; y: number }[] = []
): Option[] {
  const world = session.world;
  const seen = [...world.entities.values()].flatMap((e) =>
    e.kind === 'mobile' && e.position
      ? [{ x: e.position.x, y: e.position.y, types: (mind.call(e.serial) ?? '').split('/') }]
      : []
  );
  const sellers = new Map([...vendors, ...seen].map((v) => [`${v.x},${v.y}:${v.types.join('/')}`, v]));
  const carried = [...mind.belongings()].filter(
    ([serial, item]) =>
      (world.entities.has(serial) || mind.banked(serial)) &&
      world.entities.get(serial)?.parent !== world.serial &&
      !harvestBy(item.name) &&
      !item.name.split('/').some((type) => isA(type, 'BaseTool')) &&
      !tools.has(world.entities.get(serial)?.graphic ?? 0)
  );
  const found: Option[] = [];
  const here = world.position;
  const banker =
    here &&
    [...bankers]
      .filter((p) => !mind.steps || mind.steps({ ...here, map: world.map ?? 1 }, { ...p, z: here.z }) !== undefined)
      .sort(
        (a, b) =>
          Math.max(Math.abs(a.x - here.x), Math.abs(a.y - here.y)) -
          Math.max(Math.abs(b.x - here.x), Math.abs(b.y - here.y))
      )[0];
  for (const vendor of sellers.values()) {
    const name = vendor.types.join('/');
    const bought = new Set(vendor.types.flatMap((type) => buys(type).map((g) => g.type)));
    if (!bought.size) continue;
    const items = carried.filter(([, item]) => item.name.split('/').some((type) => bought.has(type)));
    const banked = items.filter(([serial]) => mind.banked(serial)).map(([serial]) => serial);
    if (banked.length && !banker) continue;
    const goods = items.map(([, item]) => ({ ...item }));
    const foresight = foreseeTrade('sell', name, goods);
    const selling = (names: string[]): Step => ({ verb: 'sell-to', ...vendor, names });
    if (items.length && foresight)
      found.push({
        key: `sell ${name}: ${goods
          .map((g) => `${g.amount} ${g.name}`)
          .sort()
          .join(', ')}`,
        id: `sell ${name} ${vendor.x},${vendor.y} ${items.map(([id]) => id).join(',')}`,
        foresight: { ...foresight, seconds: 3 },
        frees:
          items.reduce((sum, [id]) => sum + (mind.described(id)?.weight ?? 0), 0) -
          (foresight.gained.Gold ?? 0) * (mind.unitWeight('Gold') ?? 0),
        consumes: items.map(([id]) => id),
        steps: [
          ...(banked.length && banker
            ? ([
                { verb: 'walk', x: banker.x, y: banker.y, range: 3 },
                { verb: 'say', text: 'bank' },
                { verb: 'withdraw', items: banked }
              ] as Step[])
            : []),
          selling(items.map(([, item]) => item.name))
        ]
      });
  }
  return found;
}
