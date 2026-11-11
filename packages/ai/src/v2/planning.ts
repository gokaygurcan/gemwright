import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../terrain';
import { droppable } from './burden';
import type { Mind } from './mind';
import { movement } from './motion';
import { arming, type Option, options, type Step } from './options';

export interface Places {
  bankers: readonly { x: number; y: number }[];
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[];
  forges?: readonly { x: number; y: number; z: number; id: number }[];
}
export type Valued = Option & { source: Option; id: string; value: number; rate: number; seconds: number };
type Predicted = {
  option: Option;
  value: number;
  seconds: number;
  weight: number;
};
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function* deliberate(
  mind: Mind,
  session: PlayerSession,
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  places: Places,
  active?: Option
): Generator<void, Valued[]> {
  const world = session.world;
  const moving = movement(world, mind.locomotion.experience, mind.temper.curiosity);
  const candidates = options(mind, session, terrain, spent, places.bankers, places.vendors, places.forges);
  const inView = new Set(
    [...world.entities.values()].flatMap((e) =>
      e.kind === 'mobile' && e.serial !== world.serial ? (mind.call(e.serial)?.split('/') ?? []) : []
    )
  );
  // Of the places a kind may be found, only those no nearer one beats on the odds of finding it
  // there and getting there: a farther, less likely one of the same kind can never be worth more.
  const odds = (venture: { key: string; where: { x: number; y: number }; chance: number }) =>
    venture.chance * mind.chance(`seek ${venture.key.slice(7)} ${venture.where.x},${venture.where.y}`);
  const best = new Map<string, number>();
  const journeys = [...mind.journeys()].sort((a, b) => a.walk - b.walk);
  for (const venture of journeys) {
    yield;
    const kind = venture.key.slice(7);
    if (mind.encounter && !mind.encounter.allowsKind(kind)) continue;
    // One in view is fought where it is, not sought elsewhere.
    if (inView.has(kind)) continue;
    const chance = odds(venture);
    if (chance <= (best.get(kind) ?? 0)) continue;
    best.set(kind, chance);
    candidates.push({
      key: `go ${venture.where.x},${venture.where.y}: ${venture.key}`,
      id: `seek ${kind} ${venture.where.x},${venture.where.y}`,
      learn: venture.key,
      foresight: venture.expected,
      walk: venture.walk,
      steps: [
        ...arming(mind, session, terrain),
        { verb: 'seek', kind, x: venture.where.x, y: venture.where.y, range: 0 }
      ]
    });
  }
  if (active && !candidates.some((o) => identity(o) === identity(active))) candidates.push(active);
  const weigh = (items: Record<string, number> = {}) =>
    Object.entries(items).reduce((sum, [name, n]) => sum + (mind.unitWeight(name) ?? 0) * n, 0);
  const visible = new Map<string, number | undefined>();
  const seen = (kind: string) => {
    if (!visible.has(kind))
      visible.set(
        kind,
        [...world.entities.values()].find((e) => e.kind === 'mobile' && mind.call(e.serial)?.split('/').includes(kind))
          ?.serial
      );
    const serial = visible.get(kind);
    return serial === undefined ? undefined : world.entities.get(serial);
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
      weight: option.frees === undefined ? weigh(outcome?.gained) - weigh(outcome?.lost) : -option.frees
    };
  };
  for (const option of candidates) {
    yield;
    const prediction = forecast(option);
    if (prediction) predicted.push(prediction);
  }
  const capacity = world.status ? world.status.maxWeight - world.status.weight : Number.POSITIVE_INFINITY;
  const gold = mind.funds();
  const valued = new Map<string, Valued>();
  // Tiles to walk between two spots: along the way once the land is known (Infinity where none
  // joins them), as the crow flies only before.
  const between = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z?: number }) => {
    if (!mind.steps) return distance(a, b);
    return (
      mind.steps({ x: a.x, y: a.y, z: a.z, map: 1 }, { x: b.x, y: b.y, z: b.z ?? a.z }) ?? Number.POSITIVE_INFINITY
    );
  };
  const route = (option: Option, origin: typeof world.position) => {
    let at = origin;
    let travel = 0;
    for (const step of option.steps) {
      if (step.verb !== 'walk' && step.verb !== 'seek' && step.verb !== 'sell-to' && step.verb !== 'fight') continue;
      const observed = step.verb === 'seek' ? seen(step.kind) : undefined;
      // A place sought out of sight: its way was measured along it.
      if (step.verb === 'seek' && !observed && option.walk !== undefined) {
        travel += option.walk;
        at = { x: step.x, y: step.y, z: at?.z ?? 0, direction: 0 };
        continue;
      }
      const destination =
        step.verb === 'fight' ? world.entities.get(step.serial)?.position : (observed?.position ?? step);
      if (!destination) continue;
      if (at)
        travel += moving(
          Math.max(
            0,
            between(at, destination) -
              (step.verb === 'sell-to' ? 2 : step.verb === 'fight' || observed ? 1 : step.range)
          )
        ).seconds;
      at = { ...destination, z: 'z' in destination ? (destination.z ?? at?.z ?? 0) : (at?.z ?? 0), direction: 0 };
    }
    return { at, travel };
  };
  let opportunity = 0;
  let needed = Math.max(0, -capacity);
  for (const p of predicted) {
    yield;
    if (p.weight < 0 || p.weight <= capacity || (p.option.requiresGold ?? 0) > gold) continue;
    const elapsed = p.seconds + route(p.option, world.position).travel;
    const rate = (p.value + p.seconds) / Math.max(1, elapsed);
    if (rate <= opportunity) continue;
    opportunity = rate;
    needed = p.weight - capacity;
  }
  if (needed > 0 && opportunity > 0) {
    for (const item of droppable(mind, session)) {
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
  for (const { option, weight, seconds, value } of predicted) {
    yield;
    if ((option.requiresGold ?? 0) > gold || (weight > capacity && weight >= 0)) continue;
    const travel = route(option, world.position).travel;
    const elapsed = seconds + travel;
    if (!Number.isFinite(elapsed)) continue;
    const relief = needed > 0 ? (opportunity * Math.min(needed, Math.max(0, -weight))) / needed : 0;
    const fought = option.steps.find((s) => s.verb === 'fight');
    const sought = option.steps.find((s) => s.verb === 'seek');
    const opponent =
      fought?.verb === 'fight' ? fought.serial : sought?.verb === 'seek' ? seen(sought.kind)?.serial : undefined;
    const net = value + relief * mind.chance(identity(option)) - travel + mind.pressed(elapsed, opponent);
    const id = identity(option);
    const rate = net / Math.max(1, elapsed);
    const previous = valued.get(id);
    if (!previous || rate > previous.rate)
      valued.set(id, { ...option, source: option, id, value: net, seconds: elapsed, rate });
  }
  return [...valued.values()].sort((a, b) => b.rate - a.rate);
}

export function choices(...args: Parameters<typeof deliberate>): Valued[] {
  const work = deliberate(...args);
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}

export async function liveChoices(
  mind: Mind,
  session: PlayerSession,
  terrain: Terrain | undefined,
  spent: ReadonlySet<string>,
  places: Places,
  stopping: () => boolean,
  active?: Option
) {
  const revision = mind.revision;
  const work = deliberate(mind, session, terrain, spent, places, active);
  await Bun.sleep(0);
  // Scheduling quantum for shared socket and lease timers. Search resumes with its frontier intact.
  const sliceMs = 5;
  let until = performance.now() + sliceMs;
  while (!stopping() && mind.revision === revision) {
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
