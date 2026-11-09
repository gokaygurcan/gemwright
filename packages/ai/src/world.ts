import { readFileSync } from 'node:fs';

import type { CharacterTemplate, PopulationConfig } from './config';
import { logger } from './log';

// World configuration (world/world.json): facets and cities in play, professions with their
// archetype, behavior, creation skills, weighted starting cities and hunting grounds, and the
// population mix.
export type Behavior =
  | 'miner'
  | 'lumberjack'
  | 'fighter'
  | 'fisher'
  | 'tailor'
  | 'alchemist'
  | 'bowyer'
  | 'bard'
  | 'tamer'
  | 'thief';
interface Profession {
  archetype: string;
  behavior: Behavior;
  share: number;
  creation: { namePrefix: string; skills: Record<string, number> };
  startingCities: Record<string, number>;
  grounds?: Record<string, number>;
  trainingGoals: Record<string, number>;
  riskTolerance: number;
  supplies: Record<string, number>;
  mount?: boolean;
}
interface World {
  schemaVersion: number;
  facets: { id: number; name: string; enabled: boolean }[];
  cities: Record<string, { facet: number; enabled: boolean; startingCity: boolean }>;
  professions: Record<string, Profession>;
  // The most residents a runtime may bring in, whatever a command asks for.
  population?: { max: number };
  // Groups living apart from the main population: a fixed count in one town, by profession weight
  // (New Haven, haven.ts). Their templates are `<town>-<profession>`, like any other.
  // Life phases and the time split between them (life.ts).
  lifecycle?: {
    mix: string;
    mixes: Record<string, Record<LifePhase, number>>;
    minutes: Record<LifePhase, [number, number]>;
    maxSwitchesPerMinute: number;
    // How unpredictable residents are, 0-1 (chaos.ts); a shard's `ai.chaos` overrides it.
    chaos?: number;
  };
  // Where residents build (house-lots.ts) and the gold they keep after paying (housing.ts).
  housing?: { districts: District[]; reserve: number };
}
export interface District {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type LifePhase = 'work' | 'dungeon' | 'errands' | 'leisure' | 'visit' | 'practice';
export const world = JSON.parse(readFileSync(new URL('../world/world.json', import.meta.url), 'utf8')) as World;
if (world.schemaVersion !== 1) throw new Error('Unsupported world configuration');

const enabledFacets = new Set(world.facets.filter((f) => f.enabled).map((f) => f.id));

// The cities a shard's residents may go to (gemwright.json ai.cities): their shops, banks and
// healers, the grounds and gates around them. Every city when unset. A resident outside them works
// from the nearest allowed town (towns.ts).
let allowedCities: Set<string> | undefined;
export function useCities(cities?: readonly string[]) {
  if (!cities?.length) {
    allowedCities = undefined;
    return;
  }
  const known = new Map(Object.keys(world.cities).map((city) => [city.toLowerCase(), city]));
  const unknown = cities.filter((city) => !known.has(city.toLowerCase()));
  if (unknown.length)
    throw new Error(
      `gemwright.json ai.cities names unknown cities: ${unknown.join(', ')}. Use any of: ${[...known.values()].join(', ')}.`
    );
  allowedCities = new Set(cities.map((city) => city.toLowerCase()));
}
export const cityAllowed = (city: string) => !allowedCities || allowedCities.has(city.toLowerCase());
const allowedStart = (city: string) => {
  const entry = world.cities[city];
  return !!entry?.enabled && entry.startingCity && enabledFacets.has(entry.facet);
};

// Profession of a template id: the profession itself (`macer`), or from a former city-prefixed
// template (`<city>-<profession>`, whose residents store.ts reconcile moves to the plain one).
export function professionOf(templateId: string): [string, Profession] | undefined {
  // The longest matching id wins: `yew-archer-tamer` is an archer-tamer, not a tamer.
  return Object.entries(world.professions)
    .filter(([id]) => templateId === id || templateId.endsWith(`-${id}`))
    .sort(([a], [b]) => b.length - a.length)[0];
}
export const behaviorOf = (templateId: string): Behavior | undefined => professionOf(templateId)?.[1].behavior;

// A stable weighted pick from `weights` for `key` (starting cities, grounds), so residents spread out.
export function weightedPick(weights: Record<string, number>, key: string): string | undefined {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  let roll = total ? hash % total : 0;
  return entries.find(([, w]) => {
    roll -= w;
    return roll < 0;
  })?.[0];
}

// The template of one profession. `cities` are only where a new character may start
// (creation-request.ts); every trade works from wherever it stands (towns.ts).
function templateFor(id: string, p: Profession, cities: Record<string, number>): CharacterTemplate {
  return {
    id,
    version: 1,
    label: id,
    creation: {
      namePrefix: p.creation.namePrefix,
      cities,
      skills: p.creation.skills,
      equipment: [],
      provisioning: 'normal-character-creation'
    },
    behavior: {
      activities: [p.behavior, 'train', 'bank', 'restock', 'socialize'],
      trainingGoals: p.trainingGoals,
      riskTolerance: p.riskTolerance,
      sociability: 0.5,
      cooperation: 0.8,
      supplies: p.supplies,
      bankAtWeightRatio: 0.75,
      corpseRecovery: p.behavior === 'fighter' ? 'recover-if-safe' : 'seek-help'
    },
    archetype: { id: p.archetype, version: 1 }
  } as unknown as CharacterTemplate;
}

// One template per profession that can start somewhere in play, weighted by its share.
export function worldTemplates(): { template: CharacterTemplate; weight: number }[] {
  return Object.entries(world.professions).flatMap(([id, p]) => {
    const cities = Object.fromEntries(
      Object.entries(p.startingCities).filter(([city, w]) => w > 0 && allowedStart(city))
    );
    if (p.share <= 0 || !Object.keys(cities).length) return [];
    return [{ weight: Math.max(1, Math.round(p.share * 10)), template: templateFor(id, p, cities) }];
  });
}

// Adds the world's templates to a population (keeping existing ones) and allocates `requested`
// residents across them: one per profession first, so even a small population meets every kind of
// character, then the rest by weight (largest remainder).
export function applyWorld(population: PopulationConfig, requested: number): PopulationConfig {
  const max = world.population?.max;
  if (max !== undefined && requested > max)
    logger('world').info(`[world] ${requested} residents requested; world.json caps the population at ${max}`);
  const wanted = max === undefined ? requested : Math.min(requested, max);
  const generated = worldTemplates();
  const existing = new Set(population.templates.map((t) => t.id));
  const raw = population as unknown as { templates: unknown[] };
  for (const { template } of generated) if (!existing.has(template.id)) raw.templates.push(template);
  const counts = generated.map((g) => ({ templateId: g.template.id, count: 0 }));
  const byWeight = [...generated.keys()].sort((a, b) => (generated[b]?.weight ?? 0) - (generated[a]?.weight ?? 0));
  let left = wanted;
  for (const index of byWeight) {
    const entry = counts[index];
    if (!entry || left <= 0) continue;
    entry.count++;
    left--;
  }
  const total = generated.reduce((sum, g) => sum + g.weight, 0);
  const shares = generated.map((g, index) => ({ index, exact: (left * g.weight) / total }));
  for (const share of shares) {
    const entry = counts[share.index];
    if (entry) entry.count += Math.floor(share.exact);
  }
  left -= shares.reduce((sum, share) => sum + Math.floor(share.exact), 0);
  for (const share of shares.sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    const entry = counts[share.index];
    if (entry && left-- > 0) entry.count++;
  }
  return {
    ...population,
    targetPopulation: wanted,
    // Zero counts stay listed: a population of zero is valid and parks everyone.
    allocation: { mode: 'fixed', entries: counts }
  } as PopulationConfig;
}
