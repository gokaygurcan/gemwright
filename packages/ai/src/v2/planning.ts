import type { Terrain } from '../terrain';
import { droppable } from './burden';
import type { Mind } from './mind';
import { bodyOf, movement } from './motion';
import { arming, type Option, options, type Step } from './options';

export interface Places {
  bankers: readonly { x: number; y: number }[];
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[];
  forges?: readonly { x: number; y: number; z: number; id: number }[];
}
export type Valued = Option & {
  source: Option;
  id: string;
  value: number;
  rate: number;
  seconds: number;
  funding?: { shortfall: number; gold: number; value: number };
};
type Predicted = {
  option: Option;
  value: number;
  seconds: number;
  weight: number;
  gold: number;
};
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function* deliberate(
  mind: Mind,
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  places: Places,
  active?: Option
): Generator<void, Valued[]> {
  const moving = movement(bodyOf(mind), mind.locomotion.experience, mind.temper.curiosity);
  const candidates = options(mind, terrain, spent, places.bankers, places.vendors, places.forges);
  const inView = new Set(
    [...mind.sights()].flatMap((e) => (e.kind === 'mobile' ? (mind.call(e.serial)?.split('/') ?? []) : []))
  );
  // Of all the places the shard names, nearest-first, each kind is represented by its nearest place:
  // it starts close and widens only when a kind has nothing near left to offer. What a place last
  // showed — empty and its spawns not yet back — is already in the odds its cost is weighed with, so
  // a walked-out place stays in the list and simply ranks below better ground.
  const promised = new Set<string>();
  const journeys = [...mind.journeys()].sort((a, b) => a.walk - b.walk);
  for (const venture of journeys) {
    yield;
    const kind = venture.key.slice(7);
    if (!mind.allowed(venture.where)) continue;
    if (mind.encounter && !mind.encounter.allowsKind(kind)) continue;
    // One in view is fought where it is, not sought elsewhere.
    if (inView.has(kind)) continue;
    if (promised.has(kind)) continue;
    promised.add(kind);
    candidates.push({
      key: `go ${venture.where.x},${venture.where.y}: ${venture.key}`,
      id: `seek ${kind} ${venture.where.x},${venture.where.y}`,
      learn: venture.key,
      foresight: venture.expected,
      walk: venture.walk,
      steps: [...arming(mind, terrain), { verb: 'seek', kind, x: venture.where.x, y: venture.where.y, range: 0 }]
    });
  }
  if (
    candidates.some((o) =>
      ['mend after death', 'recover my corpse', 'ask for stuck help', 'call guards'].includes(o.key)
    )
  ) {
    candidates.splice(0, candidates.length, ...candidates.filter((o) => o.urgent));
    active = undefined;
  }
  if (active) {
    const reserved = new Set(active.consumes);
    const selling = active.steps.flatMap((step) => (step.verb === 'sell-to' ? step.names : []));
    for (const [serial, item] of mind.belongings()) {
      if (selling.some((name) => name.split('/').some((type) => item.name.split('/').includes(type))))
        reserved.add(serial);
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const option = candidates[i];
      if (
        (option?.key === 'deposit' || option?.steps.some((s) => s.verb === 'sell' || s.verb === 'sell-to')) &&
        option.consumes?.some((id) => reserved.has(id))
      )
        candidates.splice(i, 1);
    }
  }
  if (active && !candidates.some((o) => identity(o) === identity(active))) candidates.push(active);
  const weigh = (items: Record<string, number> = {}) =>
    Object.entries(items).reduce((sum, [name, n]) => sum + (mind.unitWeight(name) ?? 0) * n, 0);
  const visible = new Map<string, number | undefined>();
  const seen = (kind: string) => {
    if (!visible.has(kind))
      visible.set(
        kind,
        [...mind.sights()].find((e) => e.kind === 'mobile' && mind.call(e.serial)?.split('/').includes(kind))?.serial
      );
    const serial = visible.get(kind);
    return serial === undefined ? undefined : mind.sight(serial);
  };
  const predicted: Predicted[] = [];
  const appraisals = new Map<string, ReturnType<Mind['appraise']>>();
  const forecast = (option: Option): Predicted | undefined => {
    const seeking = option.steps.find((s) => s.verb === 'seek');
    const observed = seeking?.verb === 'seek' ? seen(seeking.kind) : undefined;
    const foresight = observed ? undefined : option.foresight;
    const fighting = option.steps.find((s) => s.verb === 'fight');
    const object = observed?.serial ?? (fighting?.verb === 'fight' ? fighting.serial : undefined);
    const key = `${option.learn ?? option.key}:${object}:${JSON.stringify(foresight)}`;
    if (!appraisals.has(key)) appraisals.set(key, mind.appraise(option.learn ?? option.key, foresight, object));
    const prediction = option.value === undefined ? appraisals.get(key) : undefined;
    if (option.value === undefined && !prediction) return undefined;
    const outcome = prediction?.outcome;
    const seconds = prediction?.seconds ?? option.seconds ?? 1;
    const raw = prediction?.value ?? option.value ?? 0;
    return {
      option,
      seconds,
      value:
        (raw + seconds) *
          mind.chance(identity(option)) *
          (option.depletion ? mind.availability(option.depletion.x, option.depletion.y) : 1) -
        seconds,
      gold:
        ((outcome?.gained.Gold ?? 0) - (outcome?.lost.Gold ?? 0) + (option.income?.gold ?? 0)) *
        mind.chance(identity(option)),
      weight:
        option.frees === undefined ? weigh(outcome?.gained) - weigh(outcome?.lost) + (option.loads ?? 0) : -option.frees
    };
  };
  for (const option of candidates) {
    yield;
    if (
      option.steps.some((s) => (s.verb === 'walk' || s.verb === 'seek' || s.verb === 'sell-to') && !mind.reachable(s))
    )
      continue;
    const prediction = forecast(option);
    if (prediction) predicted.push(prediction);
  }
  const weight = mind.self.weight;
  const capacity = weight ? weight.max - weight.current : Number.POSITIVE_INFINITY;
  const gold = mind.funds();
  const funding = predicted
    .filter((p) => p.option.requiresGold && p.option.requiresGold > gold && p.value > 0)
    .sort((a, b) => b.value / (b.option.requiresGold ?? 1) - a.value / (a.option.requiresGold ?? 1))[0];
  const neededGold = Math.max(0, (funding?.option.requiresGold ?? 0) - gold);
  const valueOfFunds = (earned: number) =>
    funding ? (Math.min(neededGold, Math.max(0, earned)) * funding.value) / (funding.option.requiresGold ?? 1) : 0;
  const valued = new Map<string, Valued>();
  // Tiles to walk between two spots: along the way once the land is known (Infinity where none
  // joins them), as the crow flies only before.
  const between = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z?: number }) => {
    if (!mind.steps) return distance(a, b);
    return (
      mind.steps({ x: a.x, y: a.y, z: a.z, map: 1 }, { x: b.x, y: b.y, z: b.z ?? a.z }) ?? Number.POSITIVE_INFINITY
    );
  };
  const route = (option: Option, origin: { x: number; y: number; z: number } | undefined) => {
    let at = origin;
    let travel = 0;
    for (const step of option.steps) {
      if (step.verb !== 'walk' && step.verb !== 'seek' && step.verb !== 'sell-to' && step.verb !== 'fight') continue;
      const observed = step.verb === 'seek' ? seen(step.kind) : undefined;
      // A place sought out of sight: its way was measured along it.
      if (step.verb === 'seek' && !observed && option.walk !== undefined) {
        travel += option.walk;
        at = { x: step.x, y: step.y, z: at?.z ?? 0 };
        continue;
      }
      const destination = step.verb === 'fight' ? mind.sight(step.serial)?.position : (observed?.position ?? step);
      if (!destination) continue;
      if (at)
        travel += moving(
          Math.max(
            0,
            between(at, destination) -
              (step.verb === 'sell-to' ? 2 : step.verb === 'fight' || observed ? 1 : step.range)
          )
        ).seconds;
      at = { x: destination.x, y: destination.y, z: 'z' in destination ? (destination.z ?? at?.z ?? 0) : (at?.z ?? 0) };
    }
    return { at, travel };
  };
  let opportunity = 0;
  let needed = Math.max(0, -capacity);
  for (const p of predicted) {
    yield;
    const peak = Math.max(p.weight, p.option.loads ?? p.weight);
    if (peak < 0 || peak <= capacity || (p.option.requiresGold ?? 0) > gold) continue;
    const elapsed = p.seconds + route(p.option, mind.position).travel;
    const rate = (p.value + p.seconds) / Math.max(1, elapsed);
    if (rate <= opportunity) continue;
    opportunity = rate;
    needed = peak - capacity;
  }
  if (needed > 0 && opportunity > 0) {
    for (const item of droppable(mind)) {
      yield;
      const option: Option = {
        key: 'make room',
        id: `drop ${item.serial}`,
        steps: [{ verb: 'drop', serial: item.serial }],
        frees: item.weight,
        value: -mind.cost(item.worth),
        seconds: 1
      };
      const prediction = forecast(option);
      if (prediction) predicted.push(prediction);
    }
  }
  for (const { option, weight, seconds, value, gold: earned } of predicted) {
    yield;
    if (
      (option.requiresGold ?? 0) > gold ||
      (weight > capacity && weight >= 0) ||
      (option.loads !== undefined && option.loads > Math.max(0, capacity))
    )
      continue;
    const travel = route(option, mind.position).travel;
    const elapsed = seconds + travel;
    if (!Number.isFinite(elapsed) || (capacity < 0 && travel > 0)) continue;
    const relief = needed > 0 ? (opportunity * Math.min(needed, Math.max(0, -weight))) / needed : 0;
    const fought = option.steps.find((s) => s.verb === 'fight');
    const sought = option.steps.find((s) => s.verb === 'seek');
    const opponent =
      fought?.verb === 'fight' ? fought.serial : sought?.verb === 'seek' ? seen(sought.kind)?.serial : undefined;
    const fundingValue = (valueOfFunds(earned) * seconds) / Math.max(1, seconds + (option.income?.seconds ?? 0));
    const net =
      value + fundingValue + relief * mind.chance(identity(option)) - travel + mind.pressed(elapsed, opponent);
    const id = identity(option);
    const rate = net / Math.max(1, elapsed);
    const previous = valued.get(id);
    if (!previous || rate > previous.rate)
      valued.set(id, {
        ...option,
        source: option,
        id,
        value: net,
        seconds: elapsed,
        rate,
        ...(fundingValue > 0 ? { funding: { shortfall: neededGold, gold: earned, value: fundingValue } } : {})
      });
  }
  return [...valued.values()].sort((a, b) => Number(b.urgent ?? false) - Number(a.urgent ?? false) || b.rate - a.rate);
}

export function choices(...args: Parameters<typeof deliberate>): Valued[] {
  const work = deliberate(...args);
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}

export async function liveChoices(
  mind: Mind,
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  places: Places,
  stopping: () => boolean,
  active?: Option,
  // False when a later change of what it perceives should not void the weighing under way.
  fresh = true
) {
  const revision = mind.revision;
  const work = deliberate(mind, terrain, spent, places, active);
  await Bun.sleep(0);
  // Scheduling quantum for shared socket and lease timers. Search resumes with its frontier intact.
  const sliceMs = 5;
  let until = performance.now() + sliceMs;
  while (!stopping() && (!fresh || mind.revision === revision)) {
    const next = work.next();
    if (next.done) return next.value;
    if (performance.now() >= until) {
      await Bun.sleep(0);
      until = performance.now() + sliceMs;
    }
  }
  work.return([]);
  return undefined;
}

export function identity(option: Option) {
  return option.id ?? `${option.key}: ${JSON.stringify(option.steps)}`;
}

export function advance(option: Option): Option {
  return { ...option, id: identity(option), steps: option.steps.slice(1) };
}

export function stance(steps: readonly Step[]): Step {
  return { verb: 'war', enabled: steps.some((s) => s.verb === 'fight' || s.verb === 'seek') };
}

export function continuation(revision: () => number, reconsider: () => boolean) {
  let previous: number | undefined;
  let keeping = true;
  return () => {
    const current = revision();
    if (previous !== current) {
      previous = current;
      keeping = reconsider();
    }
    return keeping;
  };
}
