import { TileFlag } from '@gemwright/common/assets/tiledata';
import { isA, sells } from '@gemwright/common/game/rules';

import { BANKER_SPEECH_RANGE } from './bank-rules';
import { droppable } from './burden';
import { equipmentToKeep } from './inventory';
import { foreseeHarvest, harvestBy, isKeepsake, tools, trades } from './knowledge';
import type { Mind } from './mind';
import type { Option, Step } from './options';
import type { Terrain } from './terrain';
import type { Steps } from './ventures';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// Without a tool for its trade's harvest at hand (worn out, lost with its corpse, left in the bank),
// taking one out of its bank box, or buying one from a vendor in view or the nearest the shard
// places that sells it: worth what the tool's uses would bring at
// what one use is expected to bring (ServUO harvest tools last 50 uses), less its price and the walk.
const uses = 50;
export function tooling(
  mind: Mind,
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[],
  bankers: readonly { x: number; y: number }[]
) {
  const here = mind.position;
  const owned = [...mind.belongings()].some(([serial, item]) => {
    if (mind.banked(serial)) return false;
    const harvest = harvestBy(item.name);
    return !!harvest && mind.inTrade(harvest.skill);
  });
  if (!here || owned) return [];
  const inView = [...mind.sights()]
    .filter((e) => e.kind === 'mobile' && e.position)
    .map((e) => ({ x: e.position?.x ?? 0, y: e.position?.y ?? 0, types: trades(mind.call(e.serial)) }));
  const found: Option[] = [];
  // Worth what its uses would bring at what one use is expected to bring.
  const worthOf = (tool: string) => {
    const harvest = harvestBy(tool);
    const land = harvest?.tiles.land[0];
    if (!harvest || !mind.inTrade(harvest.skill) || land === undefined) return undefined;
    return mind.appraise(
      `double-click my ${tool} > target land${land}`,
      foreseeHarvest(tool, { land }, (skill) => mind.skill(skill), mind.skillTotal)
    );
  };
  // One in its bank box, taken out at a banker.
  const banked = [...mind.belongings()].find(([serial, item]) => mind.banked(serial) && worthOf(item.name));
  const banker = byWay(mind.steps, here, here.map, bankers)[0];
  if (banked && banker) {
    const seconds = 3;
    found.push({
      key: `withdraw ${banked[1].name}`,
      id: `withdraw ${banked[0]} ${banker.x},${banker.y}`,
      value: (worthOf(banked[1].name)?.value ?? 0) * uses - seconds,
      seconds,
      steps: [
        { verb: 'walk', x: banker.x, y: banker.y, range: 3 },
        { verb: 'say', text: 'bank' },
        { verb: 'withdraw', items: [banked[0]] }
      ]
    });
  }
  const selling = (seller: { types: string[] }) =>
    seller.types.some((type) => sells(type).some((offer) => mind.inTrade(harvestBy(offer.type)?.skill ?? '')));
  const nearest = byWay(mind.steps, here, here.map, [...inView, ...vendors].filter(selling));
  for (const seller of nearest) {
    for (const offer of seller.types.flatMap((type) => sells(type))) {
      const one = worthOf(offer.type);
      if (!one) continue;
      const seconds = 3;
      found.push({
        key: `buy ${offer.type}`,
        id: `buy ${offer.type} ${seller.x},${seller.y}`,
        requiresGold: offer.price,
        value: one.value * uses - mind.cost(offer.price) - seconds,
        seconds,
        steps: [
          { verb: 'walk', x: seller.x, y: seller.y, range: 3 },
          { verb: 'buy', graphic: offer.graphic, price: offer.price }
        ]
      });
    }
  }
  const unaffordable = found.filter((option) => (option.requiresGold ?? 0) > mind.funds());
  if (mind.bankGold === undefined && banker && unaffordable.length)
    found.push({
      key: 'check bank balance',
      id: `balance ${banker.x},${banker.y}`,
      value: mind.temper.curiosity,
      seconds: 3,
      steps: [{ verb: 'walk', x: banker.x, y: banker.y, range: BANKER_SPEECH_RANGE }, { verb: 'balance' }]
    });
  return found;
}

// Putting what it carries of worth, and the crafting materials it keeps (not its tools), in its bank: at a banker in view, or the nearest
// one the shard places, the walk there part of the time it takes. A banker hears "bank" within
// a few tiles and opens its box (ServUO Banker).
export function depositing(
  mind: Mind,
  bankers: readonly { x: number; y: number }[],
  terrain?: Terrain,
  risk = 0,
  reserved: ReadonlySet<number> = new Set()
) {
  const here = mind.position;
  const pack = mind.pack;
  if (!here || pack === undefined || mind.bankCapacity.count >= mind.bankCapacity.max) return [];
  const keep = equipmentToKeep(mind, terrain);
  const items = [...mind.belongings()]
    .filter(([serial, item]) => mind.sight(serial)?.parent === pack && !harvestBy(item.name))
    .filter(
      ([serial]) =>
        (mind.care.cooldowns.get(`cleared ${serial}`) ?? 0) <= Date.now() &&
        !keep.has(serial) &&
        !reserved.has(serial) &&
        !mind.deathRobe(serial) &&
        !tools.has(mind.graphicOf(serial) ?? 0)
    )
    .map(([serial]) => serial)
    .filter((serial) => mind.worthOf(serial) > 0 || isKeepsake(mind.belongings().get(serial)?.name ?? ''));
  let slots = mind.bankCapacity.max - mind.bankCapacity.count;
  const fitting = items.filter((serial) => {
    const size =
      1 +
      [...mind.belongings().keys()].filter((id) => {
        let at = mind.sight(id)?.parent;
        for (let n = 0; at !== undefined && n < 125; n++) {
          if (at === serial) return true;
          at = mind.sight(at)?.parent;
        }
        return false;
      }).length;
    if (size > slots) return false;
    slots -= size;
    return true;
  });
  items.splice(0, items.length, ...fitting);
  if (!items.length) return [];
  const inView = [...mind.sights()]
    .filter((e) => e.kind === 'mobile' && e.position && mind.call(e.serial)?.split('/').includes('Banker'))
    .map((e) => ({ x: e.position?.x ?? 0, y: e.position?.y ?? 0 }));
  const places = new Map([...inView, ...bankers].map((p) => [`${p.x},${p.y}`, p]));
  const seconds = 2;
  return [...places.values()].map((banker) => ({
    key: 'deposit',
    id: `deposit ${banker.x},${banker.y} ${items.join(',')}`,
    consumes: items,
    frees: items.reduce((sum, id) => sum + (mind.described(id)?.weight ?? 0), 0),
    value: mind.deposit(items, risk) - seconds,
    seconds,
    steps: [
      { verb: 'walk', x: banker.x, y: banker.y, range: 3 },
      { verb: 'say', text: 'bank' },
      { verb: 'deposit', items }
    ] as Step[]
  }));
}

export function bankBatch(mind: Mind, requested: readonly { serial: number; amount: number }[], partial = false) {
  let room = mind.self.abilities().carries ?? Infinity;
  const batch: { serial: number; amount: number }[] = [];
  let weight = 0;
  for (const request of requested) {
    const item = mind.belongings().get(request.serial);
    if (!item || !mind.banked(request.serial)) return undefined;
    const unit = mind.unitWeight(item.name);
    if (unit === undefined && Number.isFinite(room)) return undefined;
    if (partial && batch.length && unit !== undefined && unit > room) continue;
    // A blocked minimum batch lets planning value freeing space before withdrawing.
    const amount = Math.min(
      request.amount,
      item.amount,
      partial && unit ? Math.max(1, Math.floor((room + 1e-9) / unit)) : request.amount
    );
    if (!partial && item.amount < request.amount) return undefined;
    if (!amount) continue;
    batch.push({ serial: request.serial, amount });
    const loaded = amount * (unit ?? 0);
    room -= loaded;
    weight += loaded;
  }
  return batch.length ? { batch, weight } : undefined;
}

// Places nearest first by the way there, not as the crow flies (one across the water is far), and
// those no way reaches left out. Before the land is known, as the crow flies.
export function byWay<T extends { x: number; y: number }>(
  steps: Steps | undefined,
  here: { x: number; y: number; z: number },
  map: number | null,
  places: readonly T[]
): T[] {
  if (!steps) return [...places].sort((a, b) => away(here, a) - away(here, b));
  return places
    .map((place) => ({ place, steps: steps({ ...here, map: map ?? 1 }, { x: place.x, y: place.y, z: here.z }) }))
    .filter((p) => p.steps !== undefined)
    .sort((a, b) => (a.steps ?? 0) - (b.steps ?? 0))
    .map((p) => p.place);
}

export function bankSteps(
  mind: Mind,
  bankers: readonly { x: number; y: number }[],
  batch: readonly { serial: number; amount: number }[]
): Step[] | undefined {
  const here = mind.position;
  if (!here) return undefined;
  const banker = byWay(mind.steps, here, here.map, bankers)[0];
  if (!banker) return undefined;
  const amounts = Object.fromEntries(
    batch.filter((r) => r.amount < (mind.belongings().get(r.serial)?.amount ?? 0)).map((r) => [r.serial, r.amount])
  );
  return [
    { verb: 'walk', x: banker.x, y: banker.y, range: 3 },
    { verb: 'say', text: 'bank' },
    { verb: 'withdraw', items: batch.map((r) => r.serial), ...(Object.keys(amounts).length ? { amounts } : {}) }
  ];
}

export function overload(mind: Mind, bankers: readonly { x: number; y: number }[]): Option[] | undefined {
  const weight = mind.self.weight;
  if (!weight || weight.current <= weight.max) return undefined;
  const excess = weight.current - weight.max;
  const here = mind.position;
  const nearBank = here && bankers.some((p) => away(p, here) <= 3);
  const items = droppable(mind);
  return items.map((item) => {
    const owned = mind.belongings().get(item.serial)?.amount ?? 1;
    const amount = Math.min(owned, Math.ceil(excess / (item.weight / owned)));
    const returning = mind.bankBox !== undefined && nearBank && mind.pack !== undefined && !mind.deathRobe(item.serial);
    return {
      key: returning ? 'return excess to bank' : 'make room',
      id: `${returning ? 'return' : 'drop'} ${item.serial}`,
      urgent: true,
      frees: returning ? (item.weight * amount) / owned : item.weight,
      value: returning ? 0 : -mind.cost(item.worth),
      seconds: 1,
      steps: returning
        ? [{ verb: 'deposit', items: [item.serial], amounts: { [item.serial]: amount } }]
        : [{ verb: 'drop', serial: item.serial }]
    };
  });
}

export function storedRobes(mind: Mind, bankers: readonly { x: number; y: number }[]): Option[] {
  return [...mind.belongings()].flatMap(([serial, item]) => {
    if (item.name !== 'DeathRobe' || !mind.banked(serial) || !mind.canDrop(serial)) return [];
    const steps = bankSteps(mind, bankers, [{ serial, amount: item.amount }]);
    return steps
      ? [
          {
            key: 'discard death robe',
            urgent: true,
            id: `discard ${serial}`,
            value: mind.temper.curiosity,
            seconds: 1,
            consumes: [serial],
            steps: [...steps, { verb: 'drop' as const, serial }]
          }
        ]
      : [];
  });
}

export function storedEquipment(mind: Mind, bankers: readonly { x: number; y: number }[], terrain?: Terrain): Option[] {
  if (!terrain?.tile || !bankers.length) return [];
  return [...equipmentToKeep(mind, terrain, true)].flatMap((serial) => {
    if (!mind.banked(serial)) return [];
    const graphic = mind.graphicOf(serial);
    if (graphic === undefined) return [];
    const tile = terrain.tile(graphic, true);
    if (!tile.layer || !(tile.flags & TileFlag.Wearable)) return [];
    const batch = bankBatch(mind, [{ serial, amount: 1 }]);
    const steps = batch && bankSteps(mind, bankers, batch.batch);
    return steps
      ? [
          {
            key: `retrieve equipment ${mind.call(serial)}`,
            id: `retrieve equipment ${serial}`,
            value: mind.cost(mind.worthOf(serial)) + mind.temper.curiosity,
            seconds: 2,
            loads: batch.weight,
            consumes: [serial],
            steps: [...steps, { verb: 'equip' as const, serial, layer: tile.layer }]
          }
        ]
      : [];
  });
}

export function inspectStored(mind: Mind, bankers: readonly { x: number; y: number }[]): Option[] {
  return [...mind.belongings()].flatMap(([serial, item]) => {
    if (
      !mind.banked(serial) ||
      mind.unitWeight(item.name) !== undefined ||
      item.name.split('/').some((type) => isA(type, 'BaseContainer') || type === 'BankBox')
    )
      return [];
    const opening = bankSteps(mind, bankers, [{ serial, amount: 1 }]);
    return opening
      ? [
          {
            key: `inspect stored ${item.name}`,
            id: `inspect stored ${serial}`,
            value: mind.temper.curiosity,
            seconds: 1,
            steps: [...opening.slice(0, 2), { verb: 'inspect' as const, serial }]
          }
        ]
      : [];
  });
}
