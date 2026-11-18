import type { Mind } from '../../../ai/src/mind';
import type { Valued } from '../../../ai/src/planning';
import { tuning } from '../../../ai/src/tuning';
import type { Recorded } from './engine';
import type { Appraisal, Scenario, Spawning, Weighing } from './types';

// A scenario set into a mind before it weighs (engine.ts), each part where the mind itself keeps
// it, and taken out again after; and what the mind took in, read back for the page.

// The parts of a mind a scenario reaches, as they are at run time.
interface Inner {
  traits: Record<string, number>;
  self: { health?: { current: number; max: number } };
  where?: { x: number; y: number; z: number; map: number | null };
  things: { names: Map<number, string> };
  ventures: {
    byType: Map<
      string,
      {
        x: number;
        y: number;
        share: Record<string, number>;
        max: number;
        delay: [number, number];
        kept: Record<string, { visits: number; finds: number; found: boolean; left?: number; empty?: boolean }>;
      }[]
    >;
  };
}
const inner = (mind: Mind) => mind as unknown as Inner;

export function applyScenario(mind: Mind, scenario: Scenario, now: number) {
  const m = inner(mind);
  const undo: (() => void)[] = [];
  const set = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    const had = Object.hasOwn(target, key);
    const was = target[key];
    target[key] = value;
    undo.push(() => {
      if (had) target[key] = was;
      else delete target[key];
    });
  };
  for (const [trait, value] of Object.entries(scenario.traits ?? {})) set(m.traits, trait, value);
  if (scenario.health !== undefined)
    set(m.self, 'health', { current: scenario.health, max: m.self.health?.max ?? scenario.health });
  if (scenario.position && m.where) set(m, 'where', { ...m.where, ...scenario.position });
  if (scenario.funds !== undefined) {
    const funds = scenario.funds;
    set(mind, 'funds', () => funds);
  }
  for (const [serial, name] of Object.entries(scenario.identities ?? {})) {
    const names = m.things.names;
    const key = Number(serial);
    const had = names.has(key);
    const was = names.get(key);
    names.set(key, name);
    // Only while it still holds what was set: something seen meanwhile renames it for good.
    undo.push(() => {
      if (names.get(key) !== name) return;
      if (had) names.set(key, was as string);
      else names.delete(key);
    });
  }
  for (const [spot, belief] of Object.entries(scenario.spawners ?? {})) {
    const [at, kind = ''] = spot.split(':');
    const [x, y] = (at ?? '').split(',').map(Number);
    const kept = m.ventures.byType.get(kind)?.find((s) => s.x === x && s.y === y)?.kept[kind];
    if (!kept) continue;
    if (belief.visits !== undefined) set(kept, 'visits', belief.visits);
    if (belief.finds !== undefined) set(kept, 'finds', belief.finds);
    if (belief.empty !== undefined) set(kept, 'empty', belief.empty);
    if (belief.leftAgo !== undefined) set(kept, 'left', now - belief.leftAgo * 1000);
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
}

export interface Watch {
  appraisals: Map<string, Appraisal>;
  chances: Record<string, number>;
  stop(): void;
}

// What the mind expects of each thing it might do and how sure it is a plan succeeds, as it weighs:
// recorded, and changed where the scenario changes them.
export function watch(mind: Mind, scenario: Scenario): Watch {
  const appraise = mind.appraise.bind(mind);
  const chance = mind.chance.bind(mind);
  const appraisals = new Map<string, Appraisal>();
  const chances: Record<string, number> = {};
  mind.appraise = (key, foresight, object) => {
    const found = appraise(key, foresight, object);
    if (!found) return found;
    const change = scenario.appraisals?.[key];
    const value = change?.value ?? found.value;
    const seconds = change?.seconds ?? found.seconds;
    if (!appraisals.has(key)) appraisals.set(key, { learn: key, n: found.n, value, seconds });
    return { ...found, value, seconds };
  };
  mind.chance = (id) => {
    const value = scenario.chances?.[id] ?? chance(id);
    chances[id] = value;
    return value;
  };
  return {
    appraisals,
    chances,
    stop: () => {
      delete (mind as Partial<Mind>).appraise;
      delete (mind as Partial<Mind>).chance;
    }
  };
}

export function inputsOf(
  mind: Mind,
  stood: Mind['position'],
  seen: Watch,
  answers: Record<string, boolean>
): Pick<
  Weighing,
  'traits' | 'health' | 'position' | 'funds' | 'sightings' | 'spawners' | 'appraisals' | 'chances' | 'answers'
> {
  const m = inner(mind);
  const away = (p?: { x: number; y: number }) =>
    p && stood ? Math.max(Math.abs(p.x - stood.x), Math.abs(p.y - stood.y)) : undefined;
  const spawners: Spawning[] = [];
  for (const venture of mind.journeys()) {
    const kind = venture.key.slice(7);
    const spot = m.ventures.byType.get(kind)?.find((s) => s.x === venture.where.x && s.y === venture.where.y);
    const kept = spot?.kept[kind];
    spawners.push({
      key: `${venture.where.x},${venture.where.y}:${kind}`,
      x: venture.where.x,
      y: venture.where.y,
      kind,
      walk: venture.walk,
      chance: venture.chance,
      share: spot?.share[kind] ?? 0,
      max: spot?.max ?? 0,
      delay: spot?.delay ?? [0, 0],
      visits: kept?.visits ?? 0,
      finds: kept?.finds ?? 0,
      empty: !!kept?.empty,
      ...(kept?.left !== undefined ? { leftAgo: Math.round((Date.now() - kept.left) / 1000) } : {})
    });
  }
  return {
    traits: { ...m.traits },
    health: { current: m.self.health?.current ?? null, max: m.self.health?.max ?? null },
    ...(stood ? { position: { x: stood.x, y: stood.y, z: stood.z } } : {}),
    funds: mind.funds(),
    sightings: [...mind.sights()]
      .filter((s) => s.kind === 'mobile')
      .map((s) => ({
        serial: s.serial,
        name: s.name ?? '',
        ...(s.position ? { x: s.position.x, y: s.position.y } : {}),
        ...(away(s.position) !== undefined ? { away: away(s.position) } : {})
      }))
      .sort((a, b) => (a.away ?? 99) - (b.away ?? 99)),
    spawners: spawners.sort((a, b) => a.walk - b.walk),
    appraisals: [...seen.appraisals.values()],
    chances: { ...seen.chances },
    answers: { ...answers }
  };
}

// What it would do with a weighing (live.ts): the best option the loop breaker lets through, or a
// change of course when even that is worth nothing; on the way, whether another is better than the
// plan under way by more than its patience holds it.
export function choose(kind: string, d: Recorded, valued: Valued[], mind: Mind, blocked: (id: string) => boolean) {
  if (kind === 'considered') {
    const best = valued.find((o) => !blocked(o.id));
    const changing = !best || (!best.urgent && best.rate <= tuning.changeCourseBelow);
    return `${changing ? 'change course' : best.key} (${best?.id ?? 'none'})`;
  }
  const current = valued.find((o) => o.id === d.id);
  const other = valued.find((o) => !blocked(o.id));
  const keeping = current?.rate ?? d.keeping ?? 0;
  const keep =
    !other ||
    other.id === d.id ||
    other.rate - keeping <=
      mind.temper.patience * tuning.patienceScale * Math.max(Math.abs(keeping), Math.abs(other.rate));
  return keep ? `kept ${d.id}` : `switched to ${other.id}`;
}
