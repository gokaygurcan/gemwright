import { readFileSync } from 'node:fs';

import type { CharacterTemplate, PopulationConfig } from './config';

// World configuration (world/world.json): facets and cities in play, professions with their
// archetype, behavior, creation skills, weighted homes and hunting grounds, and the population mix.
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
  homes: Record<string, number>;
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
  // Life phases and the time split between them (life.ts).
  lifecycle?: {
    mix: string;
    mixes: Record<string, Record<LifePhase, number>>;
    minutes: Record<LifePhase, [number, number]>;
    maxSwitchesPerMinute: number;
  };
}
export type LifePhase = 'work' | 'dungeon' | 'errands' | 'leisure' | 'visit' | 'practice';
export const world = JSON.parse(readFileSync(new URL('../world/world.json', import.meta.url), 'utf8')) as World;
if (world.schemaVersion !== 1) throw new Error('Unsupported world configuration');

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const enabledFacets = new Set(world.facets.filter((f) => f.enabled).map((f) => f.id));
const allowedHome = (city: string) => {
  const entry = world.cities[city];
  return !!entry?.enabled && entry.startingCity && enabledFacets.has(entry.facet);
};

// Profession id from a generated template id (`<home>-<profession>`).
export function professionOf(templateId: string): [string, Profession] | undefined {
  // The longest matching id wins: `yew-archer-tamer` is an archer-tamer, not a tamer.
  return Object.entries(world.professions)
    .filter(([id]) => templateId.endsWith(`-${id}`))
    .sort(([a], [b]) => b.length - a.length)[0];
}
export const behaviorOf = (templateId: string): Behavior | undefined => professionOf(templateId)?.[1].behavior;

// A stable weighted pick from `weights` for `key` (homes, grounds), so residents spread out.
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

// One template per profession and allowed home city, with the profession's share split by home weight.
export function worldTemplates(): { template: CharacterTemplate; weight: number }[] {
  return Object.entries(world.professions).flatMap(([id, p]) => {
    if (p.share <= 0) return [];
    const homes = Object.entries(p.homes).filter(([city]) => allowedHome(city));
    const total = homes.reduce((sum, [, w]) => sum + w, 0);
    return homes.map(([city, weight]) => ({
      weight: Math.max(1, Math.round((p.share * weight * 10) / total)),
      template: {
        id: `${slug(city)}-${id}`,
        version: 1,
        label: `${city} ${id}`,
        creation: {
          namePrefix: p.creation.namePrefix,
          city,
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
      } as unknown as CharacterTemplate
    }));
  });
}

// Adds the world's templates to a population (keeping existing ones) and allocates `count` residents
// across them by weight.
export function applyWorld(population: PopulationConfig, requested: number): PopulationConfig {
  const max = world.population?.max;
  if (max !== undefined && requested > max)
    console.error(`[world] ${requested} residents requested; world.json caps the population at ${max}`);
  const count = max === undefined ? requested : Math.min(requested, max);
  const generated = worldTemplates();
  const existing = new Set(population.templates.map((t) => t.id));
  const raw = population as unknown as { templates: unknown[] };
  for (const { template } of generated) if (!existing.has(template.id)) raw.templates.push(template);
  // Spread first, then weight: one resident per profession, then one per home, then the rest by
  // weight (largest remainder), so even a small population meets every kind of character.
  const counts = generated.map((g) => ({ templateId: g.template.id, count: 0 }));
  const profession = (id: string) => professionOf(id)?.[0] ?? id;
  const byWeight = [...generated.keys()].sort((a, b) => (generated[b]?.weight ?? 0) - (generated[a]?.weight ?? 0));
  let left = count;
  const seen = new Set<string>();
  for (const pass of ['profession', 'home'] as const)
    for (const index of byWeight) {
      const entry = counts[index];
      if (!entry || left <= 0 || entry.count > 0) continue;
      if (pass === 'profession' && seen.has(profession(entry.templateId))) continue;
      seen.add(profession(entry.templateId));
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
    targetPopulation: count,
    // Zero counts stay listed: a population of zero is valid and parks everyone.
    allocation: { mode: 'fixed', entries: counts }
  } as PopulationConfig;
}
