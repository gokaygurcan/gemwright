import { craftSystemOf, isA, npcTypes, sells } from '@gemwright/common/game/rules';
import { Layer } from '@gemwright/network/layers';

import type { Terrain, WorkTile } from '../terrain';
import {
  bankBatch,
  bankSteps,
  depositing,
  inspectStored,
  overload,
  storedEquipment,
  storedRobes,
  tooling
} from './banking';
import type { Outcome } from './beliefs';
import { sales } from './commerce';
import { equipmentToKeep, weaponSkill } from './inventory';
import { foreseeHarvest, foreseeSmelt, harvestBy, isForge, isStation } from './knowledge';
import type { Treatment } from './medicine';
import type { Mind } from './mind';
import { bodyOf, movement } from './motion';
import { practice } from './practice';
import { productionIncome } from './production';
import { craftSkill } from './self';
import { bankRoom, guards, insurance, mountCare, recovery, scavenging } from './upkeep';

// What its hands do, one client verb at a time (hands.ts).
export type Step =
  | { verb: 'pickup'; serial: number; amount: number }
  | { verb: 'recover-corpse'; serial?: number }
  | { verb: 'help' }
  | { verb: 'guards'; serial: number }
  | { verb: 'claim' }
  | { verb: 'clear-bank'; serial: number }
  | { verb: 'practice'; skill: string; serial?: number; ground?: boolean; delay: number; spell?: number }
  | { verb: 'walk'; x: number; y: number; range: number; running?: boolean; flying?: boolean }
  | { verb: 'seek'; kind: string; x: number; y: number; range: number }
  | { verb: 'use'; serial: number; gump?: number }
  | { verb: 'equip'; serial: number; layer: number }
  | { verb: 'stow'; serial: number }
  | { verb: 'inspect'; serial: number }
  | { verb: 'drop'; serial: number }
  | { verb: 'dismount' }
  | { verb: 'war'; enabled: boolean }
  | { verb: 'target'; serial?: number; x?: number; y?: number; z?: number; graphic?: number }
  | { verb: 'fight'; serial: number }
  | { verb: 'say'; text: string }
  | { verb: 'balance' }
  | { verb: 'deposit'; items: number[]; amounts?: Record<number, number> }
  | { verb: 'withdraw'; items: number[]; amounts?: Record<number, number> }
  | { verb: 'buy'; graphic: number; price: number; amount?: number; training?: boolean }
  | { verb: 'learn-spell'; spell: number; scroll: number; probe: boolean }
  | { verb: 'craft'; skill: string; tools: number[]; group: number; label: number; spell?: number }
  | { verb: 'sell'; vendor: number; items: number[] }
  | { verb: 'sell-to'; x: number; y: number; range?: number; types: string[]; names: string[]; except?: number[] }
  | { verb: 'gump-response'; serial: number; gump: number; button: number }
  | { verb: 'rest'; seconds: number }
  | { verb: 'escape' }
  | { verb: 'tame'; serial: number }
  | { verb: 'treat'; treatment: Treatment };

export interface Option {
  key: string;
  id?: string;
  frees?: number;
  loads?: number;
  income?: { gold: number; seconds: number };
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
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  bankers: readonly { x: number; y: number }[] = [],
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[] = [],
  forgesKnown: readonly (Spot & { id: number })[] = []
) {
  const here = mind.position;
  const found: Option[] = [];
  if (!here) return found;
  const guard = guards(mind);
  if (guard) return [guard];
  const response = mind.encounter?.response();
  if (response) return [response];
  const care = recovery(mind);
  if (care) return [care];
  const overburdened = overload(mind, bankers);
  if (overburdened) found.push(...overburdened);
  const training = practice(mind, { bankers, vendors });
  const reserved = new Set(training.flatMap((o) => o.consumes ?? []));
  found.push(
    ...scavenging(mind, terrain),
    ...mountCare(mind, vendors),
    ...insurance(mind, bankers),
    ...bankRoom(mind, bankers, terrain),
    ...training
  );
  const moving = movement(bodyOf(mind), mind.locomotion.experience, mind.temper.curiosity);
  for (const entity of mind.sights()) {
    const serial = entity.serial;
    const name = mind.call(serial);
    if (entity.kind !== 'mobile' || !name || !entity.position || away(here, entity.position) > 18) continue;
    // Only one it has read the name of, unless it struck first: a cat and a hell cat look alike.
    if (
      mind.creature(name) &&
      (entity.label ? mind.foe(name, serial) : mind.struck(serial)) &&
      (mind.encounter?.allows(serial) ?? true)
    )
      found.push({
        key: `attack ${name}`,
        id: `attack ${serial}`,
        steps: [...arming(mind, terrain), { verb: 'fight', serial }]
      });
  }
  // What it carries: its own things in view, not those in its bank box (out of reach once it closes).
  const mine = [...mind.belongings()].filter(([serial]) => mind.sight(serial) !== undefined && !mind.banked(serial));
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
      spent.has(`${spot.x},${spot.y}`) || !mind.allowed(spot) || !mind.reachable(spot)
        ? Number.NEGATIVE_INFINITY
        : rated(
            spot,
            away(here, spot),
            mind.chance(`harvest ${tool} ${spot.x},${spot.y},${spot.z}`) * mind.availability(spot.x, spot.y)
          );
    // The nearest ground worth working first: a seam a few steps away is not left for one across the
    // map. Each ring outward is only looked at while the ground inside it offers nothing worth the
    // dig — spent, exhausted, or worked out — and within a ring the yield still decides.
    let spots: WorkTile[] = [];
    for (const radius of [40, 80, 160, 320, Number.POSITIVE_INFINITY]) {
      const within = (spot: WorkTile) => away(here, spot) <= radius;
      spots = terrain.bestTiles(
        harvest.tiles,
        here,
        (spot) => (within(spot) ? score(spot) : Number.NEGATIVE_INFINITY),
        (kind, distance) => (distance > radius ? Number.NEGATIVE_INFINITY : Math.max(-1, rated(kind, distance, 1)))
      );
      if (spots.some((spot) => score(spot) >= 0)) break;
    }
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
          ...(harvest.skill === 'Lumberjacking' && mind.sight(tool)?.parent !== mind.serial
            ? [
                {
                  verb: 'equip',
                  serial: tool,
                  layer: terrain.tile(mind.graphicOf(tool) ?? 0, true).layer
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
    ...[...mind.sights()]
      .filter((e) => e.kind === 'item' && isForge(e.graphic ?? 0) && e.position)
      .map((e) => ({ ...(e.position as Spot), id: e.graphic ?? 0, serial: e.serial }))
  ]
    .filter((forge) => mind.allowed(forge))
    .sort((a, b) => away(here, a) - away(here, b));
  for (const forge of forges) {
    for (const [ore, { name, amount: owned }] of mind.belongings()) {
      const stored = mind.banked(ore);
      if (!stored && mind.sight(ore) === undefined) continue;
      const batch = stored ? bankBatch(mind, [{ serial: ore, amount: owned }], true) : undefined;
      const withdrawal = batch && bankSteps(mind, bankers, batch.batch);
      if (stored && !withdrawal) continue;
      const amount = batch?.batch[0]?.amount ?? owned;
      const type = name.split('/').find((t) => t.endsWith('Ore') && t !== 'BaseOre');
      if (!type || !forge) continue;
      const graphic = mind.graphicOf(ore) ?? 0;
      const smelt = foreseeSmelt(type, amount, graphic, mind.skill('Mining'), mind.skillTotal);
      if (!Object.values(smelt.gained).some((amount) => amount > 0)) continue;
      found.push({
        key: `double-click my ${name} > target ${forge.serial === undefined ? `tile${forge.id}` : mind.call(forge.serial)}`,
        id: `smelt ${ore} ${forge.x},${forge.y}`,
        consumes: [ore],
        loads: batch?.weight,
        frees: stored
          ? -Object.entries(smelt.gained).reduce((sum, [name, n]) => sum + n * (mind.unitWeight(name) ?? 0.1), 0)
          : Math.max(
              0,
              (mind.unitWeight(name) ?? 0) * (smelt.lost[type] ?? 0) -
                Object.entries(smelt.gained).reduce((sum, [name, n]) => sum + n * (mind.unitWeight(name) ?? 0.1), 0)
            ),
        steps: [
          ...(withdrawal ?? []),
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
  found.push(...taming(mind));
  found.push(...sales(mind, vendors, bankers, terrain, reserved));
  found.push(...inspectStored(mind, bankers));
  found.push(...storedEquipment(mind, bankers, terrain));
  found.push(...storedRobes(mind, bankers));
  found.push(...tooling(mind, vendors, bankers));
  found.push(...interactions(mind, bankers, reserved));
  const work = productionIncome(mind, found, vendors);
  const next = work
    .filter((o) => (o.requiresGold ?? 0) <= mind.funds())
    .map((o) => ({
      option: o,
      prediction: mind.appraise(o.learn ?? o.key, o.foresight)
    }))
    .sort(
      (a, b) =>
        (b.option.value ?? b.prediction?.value ?? -Infinity) /
          Math.max(1, b.prediction?.seconds ?? b.option.seconds ?? 1) -
        (a.option.value ?? a.prediction?.value ?? -Infinity) /
          Math.max(1, a.prediction?.seconds ?? a.option.seconds ?? 1)
    )[0];
  if (!overburdened) work.push(...depositing(mind, bankers, terrain, next?.prediction?.outcome?.died ?? 0, reserved));
  return work;
}

// What what it carries and who stands near offer beyond the trades it already knows: a thing whose
// use answers with a menu, or a person, is tried once on its own, and what it answers with becomes
// the affordances to choose among — every button of every menu reachable from the one its use opens,
// each answered along the chain of buttons that leads there, or a station to work where a tool's use
// asks for a target. Whatever the trade (blacksmithing, tailoring, carpentry, tinkering...) and
// whoever the person, the same rules and answers carry it, with no branch per profession or per
// relation. What each interaction costs and brings is learned by trying it (mind.ts); one it has
// priced is not offered while it cannot pay.
function interactions(
  mind: Mind,
  bankers: readonly { x: number; y: number }[],
  reserved: ReadonlySet<number> = new Set()
) {
  const here = mind.position;
  const found: Option[] = [];
  if (!here) return found;
  const stations = [...mind.sights()]
    .filter((entity) => entity.kind === 'item' && entity.position && isStation(entity.graphic ?? 0))
    .sort((a, b) => away(here, a.position as Spot) - away(here, b.position as Spot));
  const inputs = (key: string) => {
    const expected = mind.appraise(key)?.outcome;
    const requested: { serial: number; amount: number }[] = [];
    const consumes: number[] = [];
    for (const [name, amount] of Object.entries(expected?.lost ?? {})) {
      let remaining = Math.ceil(amount);
      for (const [serial, item] of mind.belongings()) {
        if (
          !remaining ||
          mind.banked(serial) ||
          mind.sight(serial) === undefined ||
          !item.name.split('/').some((type) => name.split('/').includes(type))
        )
          continue;
        consumes.push(serial);
        remaining -= Math.min(remaining, item.amount);
      }
      let missing = remaining;
      for (const [serial, item] of mind.belongings()) {
        if (!missing || !mind.banked(serial) || !item.name.split('/').some((type) => name.split('/').includes(type)))
          continue;
        const taking = Math.min(missing, item.amount);
        requested.push({ serial, amount: taking });
        consumes.push(serial);
        missing -= taking;
      }
      if (missing > 0) return undefined;
    }
    if (!requested.length) return { steps: [] as Step[], consumes, weight: 0 };
    const batch = bankBatch(mind, requested);
    const steps = batch && bankSteps(mind, bankers, batch.batch);
    return batch && steps ? { steps, consumes: requested.map((r) => r.serial), weight: batch.weight } : undefined;
  };
  // Every menu reachable from the one a use opens, each reached by answering the buttons that lead
  // there: the whole chain, its branches, and the ways back to where it started. `address` is what
  // the keys call it, `name` what its menus are kept under.
  const menus = (address: string, name: string, serial: number, before: Step[]) => {
    const rootKey = mind.root(name);
    const root = rootKey === undefined ? undefined : mind.menu(rootKey);
    if (rootKey === undefined || !root) return false;
    const reached: { key: string; via: { serial: number; gump: number; button: number }[] }[] = [
      { key: rootKey, via: [] }
    ];
    for (const node of reached) {
      const menu = mind.menu(node.key);
      if (!menu) continue;
      for (const button of menu.buttons) {
        const path = node.via.map((step) => ` > gump-response ${step.gump}:${step.button}`).join('');
        const key = `double-click ${address}${path} > gump-response ${menu.gump}:${button}`;
        const supply = inputs(key);
        if (!supply) continue;
        found.push({
          key,
          id: `interact ${serial} ${node.via.map((step) => `${step.gump}:${step.button}>`).join('')}${menu.gump}:${button}`,
          consumes: supply.consumes,
          loads: supply.weight,
          steps: [
            ...supply.steps,
            ...before,
            { verb: 'use', serial, gump: root.gump },
            ...node.via.map((step) => ({ verb: 'gump-response' as const, ...step })),
            { verb: 'gump-response', serial: menu.serial, gump: menu.gump, button }
          ],
          ...(mind.knows(key) ? {} : { value: mind.temper.curiosity, seconds: 1 })
        });
      }
      if (node.via.length >= 3) continue;
      for (const button of menu.buttons) {
        const child = mind.through(node.key, button);
        if (child === undefined || reached.some((seen) => seen.key === child) || !mind.menu(child)) continue;
        reached.push({ key: child, via: [...node.via, { serial: menu.serial, gump: menu.gump, button }] });
      }
    }
    return true;
  };
  for (const [serial, item] of mind.belongings()) {
    if (mind.sight(serial) === undefined || mind.banked(serial) || reserved.has(serial)) continue;
    // Only the tools of a craft it has some skill in.
    const system = item.name
      .split('/')
      .map((type) => craftSystemOf(type))
      .find(Boolean);
    if (!system || !(mind.skill(craftSkill[system] ?? '') > 0)) continue;
    if (menus(`my ${item.name}`, item.name, serial, [])) continue;
    if (mind.asksTarget(item.name)) {
      const station = stations.find((entity) => entity.position !== undefined && away(here, entity.position) <= 18);
      if (station?.position !== undefined) {
        const key = `double-click my ${item.name} > target ${mind.call(station.serial)}`;
        const supply = inputs(key);
        if (supply)
          found.push({
            key,
            id: `work ${serial} ${station.serial}`,
            consumes: supply.consumes,
            loads: supply.weight,
            steps: [...supply.steps, { verb: 'use', serial }, { verb: 'target', serial: station.serial }],
            ...(mind.knows(key) ? {} : { value: mind.temper.curiosity, seconds: 1 })
          });
      }
      continue;
    }
    if (!mind.tried(item.name))
      found.push({
        key: `double-click my ${item.name}`,
        id: `probe ${serial}`,
        steps: [{ verb: 'use', serial }],
        value: mind.temper.curiosity,
        seconds: 1
      });
  }
  // A person answers to being addressed as a tool does: tried once on its own, then weighed by what
  // its answers bring, each answer learned of that person alone under the name it calls itself. Not
  // a tool of any trade and not quarry: no station to work and no cursor, only what it answers.
  for (const entity of mind.sights()) {
    const serial = entity.serial;
    if (entity.kind !== 'mobile' || !entity.position || serial === mind.mount) continue;
    const name = mind.call(serial);
    const label = mind.label(serial);
    if (!name || !label || mind.creature(name) || away(here, entity.position) > 18) continue;
    const walk: Step = { verb: 'walk', x: entity.position.x, y: entity.position.y, range: 2 };
    if (menus(label, label, serial, [walk])) continue;
    if (!mind.tried(label))
      found.push({
        key: `double-click ${label}`,
        id: `greet ${serial}`,
        steps: [walk, { verb: 'use', serial }],
        value: mind.temper.curiosity,
        seconds: 1
      });
  }
  return found;
}

// What a vendor asks for a creature (an animal trainer's horse): what taming one saves.
const prices = new Map<string, number | undefined>();
const boughtFor = (type: string) => {
  if (!prices.has(type))
    prices.set(
      type,
      npcTypes
        .flatMap((npc) => sells(npc).filter((offer) => offer.type === type))
        .reduce<number | undefined>(
          (low, offer) => (low === undefined || offer.price < low ? offer.price : low),
          undefined
        )
    );
  return prices.get(type);
};

// With no mount of its own, a mount it can tame in view (self.ts `abilities().tames`): worth what
// a trainer asks for one at the odds of taming it, over the 9 to 12 seconds a try takes (ServUO
// AnimalTaming), then ridden.
function taming(mind: Mind): Option[] {
  const here = mind.position;
  if (!here || mind.riding || mind.mount !== undefined) return [];
  const tames = new Map(
    mind.self
      .abilities()
      .tames.filter((c) => c.mount)
      .map((c) => [c.name, c])
  );
  const found: Option[] = [];
  for (const entity of mind.sights()) {
    const serial = entity.serial;
    if (entity.kind !== 'mobile' || !entity.position || away(here, entity.position) > 18) continue;
    const kind = mind
      .call(serial)
      ?.split('/')
      .find((type) => tames.has(type));
    const can = kind === undefined ? undefined : tames.get(kind);
    const price = kind === undefined ? undefined : boughtFor(kind);
    if (!kind || !can || !price) continue;
    const seconds = 12;
    found.push({
      key: `tame ${kind}`,
      id: `tame ${serial}`,
      value: can.chance * price - seconds,
      seconds,
      steps: [
        { verb: 'walk', x: entity.position.x, y: entity.position.y, range: 2 },
        { verb: 'tame', serial },
        { verb: 'use', serial }
      ]
    });
  }
  return found;
}

export function arming(mind: Mind, terrain: Terrain | undefined): Step[] {
  const inHands = (e: { parent?: number; layer?: number }) =>
    e.parent === mind.serial && (e.layer === Layer.OneHanded || e.layer === Layer.TwoHanded);
  const held = [...mind.sights()].filter((e) => inHands(e) && weaponSkill(mind.belongings().get(e.serial)?.name ?? ''));
  const keep = [...equipmentToKeep(mind, terrain)].filter((serial) => {
    const name = mind.belongings().get(serial)?.name ?? '';
    return weaponSkill(name) || name.split('/').some((type) => isA(type, 'BaseShield'));
  });
  const weapon = keep.find((serial) => weaponSkill(mind.belongings().get(serial)?.name ?? ''));
  const skill = weapon === undefined ? undefined : weaponSkill(mind.belongings().get(weapon)?.name ?? '');
  if (skill && mind.skill(skill) < mind.skill('Wrestling'))
    return held.map((e) => ({ verb: 'stow' as const, serial: e.serial }));
  if (!terrain) return [];
  // The shield first: putting it on frees the hand a two-handed weapon held.
  const order = keep.sort((a, b) => Number(a === weapon) - Number(b === weapon));
  return order.flatMap((serial) => {
    const item = mind.sight(serial);
    if (!item || item.parent === mind.serial || item.graphic === undefined) return [];
    const layer = terrain.tile(item.graphic, true).layer;
    return layer ? [{ verb: 'equip' as const, serial, layer }] : [];
  });
}

const forgeGraphics = new Set([4017, ...Array.from({ length: 48 }, (_, i) => 6522 + i)]);
