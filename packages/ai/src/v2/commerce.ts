import { buys, isA } from '@gemwright/common/game/rules';

import type { Terrain } from '../terrain';
import { bankBatch, bankSteps } from './banking';
import { equipmentToKeep } from './inventory';
import { foreseeTrade, harvestBy, tools } from './knowledge';
import type { Mind } from './mind';
import type { Option, Step } from './options';

export function sales(
  mind: Mind,
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[],
  bankers: readonly { x: number; y: number }[] = [],
  terrain?: Terrain,
  reserved: ReadonlySet<number> = new Set()
): Option[] {
  const seen = [...mind.sights()].flatMap((e) =>
    e.kind === 'mobile' && e.position
      ? [{ x: e.position.x, y: e.position.y, types: (mind.call(e.serial) ?? '').split('/') }]
      : []
  );
  const sellers = new Map([...vendors, ...seen].map((v) => [`${v.x},${v.y}:${v.types.join('/')}`, v]));
  const keep = equipmentToKeep(mind, terrain, true);
  const carried = [...mind.belongings()].filter(
    ([serial, item]) =>
      (mind.sight(serial) !== undefined || mind.banked(serial)) &&
      !keep.has(serial) &&
      !reserved.has(serial) &&
      item.name !== 'DeathRobe' &&
      !mind.deathRobe(serial) &&
      mind.sight(serial)?.parent !== mind.serial &&
      !harvestBy(item.name) &&
      !item.name.split('/').some((type) => isA(type, 'BaseTool')) &&
      !tools.has(mind.graphicOf(serial) ?? 0)
  );
  const found: Option[] = [];
  for (const vendor of sellers.values()) {
    const name = vendor.types.join('/');
    const bought = new Set(vendor.types.flatMap((type) => buys(type).map((g) => g.type)));
    if (!bought.size) continue;
    let items = carried.filter(([, item]) => item.name.split('/').some((type) => bought.has(type)));
    const banked = items
      .filter(([serial]) => mind.banked(serial))
      .map(([serial, item]) => ({ serial, amount: item.amount }));
    const batch = banked.length ? bankBatch(mind, banked, true) : undefined;
    const withdrawal = batch ? bankSteps(mind, bankers, batch.batch) : undefined;
    if (banked.length) {
      const amounts = new Map(withdrawal ? batch?.batch.map((r) => [r.serial, r.amount]) : []);
      items = items.flatMap(([serial, item]) =>
        !mind.banked(serial)
          ? [[serial, item] as const]
          : amounts.has(serial)
            ? [[serial, { ...item, amount: amounts.get(serial) as number }] as const]
            : []
      );
    }
    const goods = items.map(([, item]) => ({ ...item }));
    const foresight = foreseeTrade('sell', name, goods);
    const selling = (names: string[]): Step => {
      const except = [...keep].filter((serial) =>
        names.some((name) =>
          name.split('/').some((type) => mind.belongings().get(serial)?.name.split('/').includes(type))
        )
      );
      return { verb: 'sell-to', ...vendor, names, ...(except.length ? { except } : {}) };
    };
    if (items.length && foresight)
      found.push({
        key: `sell ${name}: ${goods
          .map((g) => `${g.amount} ${g.name}`)
          .sort()
          .join(', ')}`,
        id: `sell ${name} ${vendor.x},${vendor.y} ${items.map(([id]) => id).join(',')}`,
        foresight: { ...foresight, seconds: 3 },
        frees:
          items.reduce((sum, [id]) => sum + (mind.banked(id) ? 0 : (mind.described(id)?.weight ?? 0)), 0) -
          (foresight.gained.Gold ?? 0) * (mind.unitWeight('Gold') ?? 0),
        loads: batch?.weight,
        consumes: items.map(([id]) => id),
        steps: [...(withdrawal ?? []), selling(items.map(([, item]) => item.name))]
      });
  }
  return found;
}
