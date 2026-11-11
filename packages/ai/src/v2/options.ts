import { sells, skillOf } from '@gemwright/common/game/rules';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain, WorkTile } from '../terrain';
import { BANKER_SPEECH_RANGE } from '../v1/bank-gold';
import type { Outcome } from './beliefs';
import { sales } from './commerce';
import { foreseeHarvest, foreseeSmelt, harvestBy, isForge, isKeepsake, tools } from './knowledge';
import type { Treatment } from './medicine';
import type { Mind } from './mind';
import { movement } from './motion';

// What its hands do, one client verb at a time (hands.ts).
export type Step =
  | { verb: 'walk'; x: number; y: number; range: number; running?: boolean; flying?: boolean }
  | { verb: 'seek'; kind: string; x: number; y: number; range: number }
  | { verb: 'use'; serial: number }
  | { verb: 'equip'; serial: number; layer: number }
  | { verb: 'drop'; serial: number }
  | { verb: 'dismount' }
  | { verb: 'war'; enabled: boolean }
  | { verb: 'target'; serial?: number; x?: number; y?: number; z?: number; graphic?: number }
  | { verb: 'fight'; serial: number }
  | { verb: 'say'; text: string }
  | { verb: 'balance' }
  | { verb: 'deposit'; items: number[] }
  | { verb: 'withdraw'; items: number[] }
  | { verb: 'buy'; graphic: number; price: number }
  | { verb: 'sell'; vendor: number; items: number[] }
  | { verb: 'sell-to'; x: number; y: number; range?: number; types: string[]; names: string[] }
  | { verb: 'rest'; seconds: number }
  | { verb: 'escape' }
  | { verb: 'treat'; treatment: Treatment };

export interface Option {
  key: string;
  id?: string;
  frees?: number;
  consumes?: number[];
  requiresGold?: number;
  depletion?: { x: number; y: number; width: number; height: number; respawn: number };
  learn?: string;
  steps: Step[];
  foresight?: Partial<Outcome>;
  // Worth weighed here rather than foreseen (a deposit), and how long it takes.
  value?: number;
  seconds?: number;
  urgent?: boolean;
  // The seconds of the way to somewhere it seeks, measured along that way (walk-graph.ts).
  walk?: number;
}
type Spot = { x: number; y: number; z: number };

// ServUO harvest and smelting both want two tiles of reach.
const reach = 2;
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// What it could do here and now with what it has and what it sees, each as the attempt it would be
// (the key the mind learns it by), the client verbs that make it, and what the wiki foresees of it:
// fighting a creature in view, working a tile with a tool it carries, smelting ore at a forge,
// selling what it carries to a vendor who buys it. Spots it found spent are left alone.
export function options(
  mind: Mind,
  session: PlayerSession,
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  bankers: readonly { x: number; y: number }[] = [],
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[] = [],
  forgesKnown: readonly (Spot & { id: number })[] = []
) {
  const world = session.world;
  const here = world.position;
  const found: Option[] = [];
  if (!here) return found;
  const response = mind.encounter?.response();
  if (response) return [response];
  const moving = movement(world, mind.locomotion.experience, mind.temper.curiosity);
  const near = (serial: number) => {
    const at = world.entities.get(serial)?.position;
    return at && away(here, at) <= 18 ? at : undefined;
  };
  for (const [serial, entity] of world.entities) {
    const name = mind.call(serial);
    if (entity.kind !== 'mobile' || serial === world.serial || !name || !near(serial)) continue;
    // Only one it has read the name of, unless it struck first: a cat and a hell cat look alike.
    if (
      mind.creature(name) &&
      (entity.name ? mind.foe(name, serial) : mind.struck(serial)) &&
      (mind.encounter?.allows(serial) ?? true)
    )
      found.push({
        key: `attack ${name}`,
        id: `attack ${serial}`,
        steps: [...arming(mind, session, terrain), { verb: 'fight', serial }]
      });
  }
  // What it carries: its own things in view, not those in its bank box (out of reach once it closes).
  const mine = [...mind.belongings()].filter(([serial]) => world.entities.has(serial) && !mind.banked(serial));
  for (const [tool, { name }] of mine) {
    const harvest = harvestBy(name);
    if (!harvest || !terrain) continue;
    // Equivalent affordances compete by value and travel cost across the whole map.
    const appraisals = new Map<string, ReturnType<Mind['appraise']>>();
    const appraisal = (spot: Pick<WorkTile, 'id' | 'land'>) => {
      const target = spot.id === undefined ? `land${spot.land}` : `tile${spot.id}`;
      if (!appraisals.has(target)) {
        const expected = foreseeHarvest(
          name,
          spot.id === undefined ? { land: spot.land } : { tile: spot.id },
          (skill) => mind.skill(skill),
          mind.skillTotal
        );
        appraisals.set(
          target,
          mind.appraise(`double-click my ${name} > target ${target}`, { ...expected, seconds: 1.6 })
        );
      }
      return appraisals.get(target);
    };
    const rated = (spot: Pick<WorkTile, 'id' | 'land'>, distance: number, chance: number) => {
      const expected = appraisal(spot);
      if (!expected) return Number.NEGATIVE_INFINITY;
      const travel = moving(Math.max(0, distance - reach)).seconds;
      return (
        ((expected.value + expected.seconds) * chance - expected.seconds - travel) /
        Math.max(1, expected.seconds + travel)
      );
    };
    const score = (spot: WorkTile) =>
      spent.has(`${spot.x},${spot.y}`)
        ? Number.NEGATIVE_INFINITY
        : rated(
            spot,
            away(here, spot),
            mind.chance(`harvest ${tool} ${spot.x},${spot.y},${spot.z}`) * mind.availability(spot.x, spot.y)
          );
    const spots = terrain.bestTiles(harvest.tiles, here, score, (kind, distance) =>
      Math.max(-1, rated(kind, distance, 1))
    );
    for (const spot of spots) {
      const target = spot.id === undefined ? `land${spot.land}` : `tile${spot.id}`;
      found.push({
        key: `double-click my ${name} > target ${target}`,
        id: `harvest ${tool} ${spot.x},${spot.y},${spot.z}`,
        depletion: { x: spot.x, y: spot.y, ...harvest.bank },
        steps: [
          { verb: 'walk', x: spot.x, y: spot.y, range: reach },
          // The shard's own conditions: no mining while riding, no chopping with an axe not in hand.
          ...(harvest.skill === 'Mining' ? [{ verb: 'dismount' } as const] : []),
          ...(harvest.skill === 'Lumberjacking' && world.entities.get(tool)?.parent !== world.serial
            ? [
                {
                  verb: 'equip',
                  serial: tool,
                  layer: terrain.tile(world.entities.get(tool)?.graphic ?? 0, true).layer
                } as const
              ]
            : []),
          { verb: 'use', serial: tool },
          { verb: 'target', x: spot.x, y: spot.y, z: spot.z, graphic: spot.id ?? 0 }
        ],
        foresight: {
          ...foreseeHarvest(
            name,
            spot.id === undefined ? { land: spot.land } : { tile: spot.id },
            (skill) => mind.skill(skill),
            mind.skillTotal
          ),
          seconds: 1.6
        }
      });
    }
  }
  const forges = [
    ...forgesKnown.map((f) => ({ ...f, serial: undefined })),
    ...[...(terrain?.findTiles({ land: [], statics: [...forgeGraphics] }) ?? [])].map((f) => ({
      ...f,
      id: f.id ?? 0,
      serial: undefined
    })),
    ...[...world.entities.values()]
      .filter((e) => e.kind === 'item' && isForge(e.graphic) && e.position)
      .map((e) => ({ ...(e.position as Spot), id: e.graphic, serial: e.serial }))
  ].sort((a, b) => away(here, a) - away(here, b));
  for (const forge of forges) {
    for (const [ore, { name, amount }] of mine) {
      const type = name.split('/').find((t) => t.endsWith('Ore'));
      if (!type || !forge) continue;
      const graphic = world.entities.get(ore)?.graphic ?? 0;
      const smelt = foreseeSmelt(type, amount, graphic, mind.skill('Mining'), mind.skillTotal);
      if (!Object.values(smelt.gained).some((amount) => amount > 0)) continue;
      found.push({
        key: `double-click my ${name} > target ${forge.serial === undefined ? `tile${forge.id}` : mind.call(forge.serial)}`,
        id: `smelt ${ore} ${forge.x},${forge.y}`,
        consumes: [ore],
        frees: Math.max(
          0,
          (mind.unitWeight(name) ?? 0) * (smelt.lost[type] ?? 0) -
            Object.values(smelt.gained).reduce((sum, n) => sum + n * 0.1, 0)
        ),
        steps: [
          { verb: 'walk', x: forge.x, y: forge.y, range: reach },
          { verb: 'use', serial: ore },
          forge.serial === undefined
            ? { verb: 'target', x: forge.x, y: forge.y, z: forge.z, graphic: forge.id }
            : { verb: 'target', serial: forge.serial }
        ],
        foresight: { ...smelt, seconds: 1 }
      });
    }
  }
  found.push(...sales(mind, session, vendors, bankers));
  found.push(...depositing(mind, session, bankers));
  found.push(...tooling(mind, session, vendors, bankers));
  return found;
}

// Without a tool for its trade's harvest at hand (worn out, lost with its corpse, left in the bank),
// taking one out of its bank box, or buying one from a vendor in view or the nearest the shard
// places that sells it: worth what the tool's uses would bring at
// what one use is expected to bring (ServUO harvest tools last 50 uses), less its price and the walk.
const uses = 50;
function tooling(
  mind: Mind,
  session: PlayerSession,
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[],
  bankers: readonly { x: number; y: number }[]
) {
  const here = session.world.position;
  const owned = [...mind.belongings()].some(([serial, item]) => {
    if (mind.banked(serial)) return false;
    const harvest = harvestBy(item.name);
    return !!harvest && mind.inTrade(harvest.skill);
  });
  if (!here || owned) return [];
  const inView = [...session.world.entities.values()]
    .filter((e) => e.kind === 'mobile' && e.position && e.serial !== session.world.serial)
    .map((e) => ({ x: e.position?.x ?? 0, y: e.position?.y ?? 0, types: (mind.call(e.serial) ?? '').split('/') }));
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
  const banker = [...bankers].sort((a, b) => away(here, a) - away(here, b))[0];
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
  const nearest = [...inView, ...vendors].filter(selling).sort((a, b) => away(here, a) - away(here, b));
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
      value: Math.max(...unaffordable.map((option) => option.value ?? 0)),
      seconds: 3,
      steps: [{ verb: 'walk', x: banker.x, y: banker.y, range: BANKER_SPEECH_RANGE }, { verb: 'balance' }]
    });
  return found;
}

// Into its hand before a fight: the weapon of its trade it carries worth the most, unless it holds one.
export function arming(mind: Mind, session: PlayerSession, terrain: Terrain | undefined): Step[] {
  const world = session.world;
  const fighting = (serial: number) =>
    (mind.belongings().get(serial)?.name ?? '').split('/').some((type) => {
      const skill = skillOf(type);
      return !!skill && mind.inTrade(skill);
    });
  const held = [...world.entities.values()].some(
    (e) =>
      e.parent === world.serial && (e.layer === Layer.OneHanded || e.layer === Layer.TwoHanded) && fighting(e.serial)
  );
  if (held || !terrain) return [];
  const best = [...mind.belongings().keys()]
    .filter((serial) => world.entities.get(serial)?.parent !== world.serial && fighting(serial))
    .sort((a, b) => mind.worthOf(b) - mind.worthOf(a))[0];
  const item = best === undefined ? undefined : world.entities.get(best);
  return best === undefined || !item
    ? []
    : [{ verb: 'equip', serial: best, layer: terrain.tile(item.graphic, true).layer }];
}

// Putting what it carries of worth, and the crafting materials it keeps (not its tools), in its bank: at a banker in view, or the nearest
// one the shard places, the walk there part of the time it takes. A banker hears "bank" within
// a few tiles and opens its box (ServUO Banker).
function depositing(mind: Mind, session: PlayerSession, bankers: readonly { x: number; y: number }[]) {
  const world = session.world;
  const here = world.position;
  const pack = [...world.entities.values()].find((e) => e.parent === world.serial && e.layer === Layer.Backpack);
  if (!here || !pack) return [];
  const items = [...mind.belongings()]
    .filter(([serial, item]) => world.entities.get(serial)?.parent === pack.serial && !harvestBy(item.name))
    .filter(([serial]) => !tools.has(world.entities.get(serial)?.graphic ?? 0))
    .map(([serial]) => serial)
    .filter((serial) => mind.worthOf(serial) > 0 || isKeepsake(mind.belongings().get(serial)?.name ?? ''));
  if (!items.length) return [];
  const inView = [...world.entities.values()]
    .filter((e) => e.kind === 'mobile' && e.position && mind.call(e.serial)?.split('/').includes('Banker'))
    .map((e) => ({ x: e.position?.x ?? 0, y: e.position?.y ?? 0 }));
  const places = new Map([...inView, ...bankers].map((p) => [`${p.x},${p.y}`, p]));
  const seconds = 2;
  return [...places.values()].map((banker) => ({
    key: 'deposit',
    id: `deposit ${banker.x},${banker.y} ${items.join(',')}`,
    consumes: items,
    frees: items.reduce((sum, id) => sum + (mind.described(id)?.weight ?? 0), 0),
    value: mind.deposit(items) - seconds,
    seconds,
    steps: [
      { verb: 'walk', x: banker.x, y: banker.y, range: 3 },
      { verb: 'say', text: 'bank' },
      { verb: 'deposit', items }
    ] as Step[]
  }));
}

const forgeGraphics = new Set([4017, ...Array.from({ length: 48 }, (_, i) => 6522 + i)]);
