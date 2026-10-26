import { readFileSync } from 'node:fs';

export type ServiceType =
  | 'animal-trainer'
  | 'banker'
  | 'healer'
  | 'alchemist'
  | 'tailor'
  | 'blacksmith'
  | 'jeweler'
  | 'mining-tools'
  | 'carpenter'
  | 'graveyard'
  | 'tinker'
  | 'mage'
  | 'bowyer'
  | 'weaponsmith'
  | 'fisherman'
  | 'bard'
  | 'cook'
  | 'architect'
  | 'provisioner';
export interface Landmark {
  name: string;
  city: string;
  facet: number;
  x: number;
  y: number;
}
interface Point {
  name: string;
  x: number;
  y: number;
}
interface Reference {
  name: string;
  x?: number;
  y?: number;
}
const source = JSON.parse(readFileSync(new URL('../locations/locations.json', import.meta.url), 'utf8')) as Record<
  string,
  Point[]
>;
type Bindings = {
  schemaVersion: number;
  facet: number;
  cities: Record<string, Partial<Record<ServiceType, Reference[]>>>;
};
const load = (file: string) =>
  JSON.parse(readFileSync(new URL(`../locations/${file}`, import.meta.url), 'utf8')) as Bindings;
// Hand-curated services first, then shops generated from ServUO's Data/Guide/*.graph vertices.
const bindings = load('services.json');
const guide = load('services-guide.json');
for (const catalogFile of [bindings, guide])
  if (catalogFile.schemaVersion !== 1 || catalogFile.facet !== 1)
    throw new Error('Unsupported navigation catalog version or facet');
for (const [city, services] of Object.entries(guide.cities)) {
  const merged = bindings.cities[city] ?? {};
  bindings.cities[city] = merged;
  for (const [service, entries] of Object.entries(services) as [ServiceType, Reference[]][])
    merged[service] = [...(merged[service] ?? []), ...entries];
}
const catalog = new Map<string, readonly Landmark[]>();
for (const [city, services] of Object.entries(bindings.cities)) {
  for (const [service, entries] of Object.entries(services)) {
    const points = entries.map((entry): Landmark => {
      const matches = (source[city] ?? []).filter((item) => item.name === entry.name);
      if (entry.x === undefined && matches.length !== 1)
        throw new Error(`Ambiguous or missing ${city} landmark: ${entry.name}`);
      const point = entry.x === undefined ? matches[0] : entry;
      if (
        !point ||
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        (point.x ?? -1) < 1 ||
        (point.x ?? 7166) > 7165 ||
        (point.y ?? -1) < 1 ||
        (point.y ?? 4094) > 4093
      )
        throw new Error(`Invalid navigation landmark: ${city}/${entry.name}`);
      return Object.freeze({
        name: entry.name,
        city,
        facet: bindings.facet,
        x: point.x as number,
        y: point.y as number
      });
    });
    catalog.set(`${city.toLowerCase()}:${service}`, Object.freeze(points));
  }
}

export function serviceLocations(city: string, service: ServiceType): readonly Landmark[] {
  return catalog.get(`${city.toLowerCase()}:${service}`) ?? [];
}

// Every configured landmark of one service type, across all cities.
export function allServiceLocations(service: ServiceType): Landmark[] {
  return [...catalog].flatMap(([key, points]) => (key.endsWith(`:${service}`) ? [...points] : []));
}

// Where to go for a service: any of the town's landmarks of that kind, at random, so residents do
// not all walk to the same spot (the nearer ones more often when a starting point is given).
export function pickLocation(
  city: string,
  service: ServiceType,
  from?: { x: number; y: number }
): Landmark | undefined {
  const points = serviceLocations(city, service);
  if (points.length < 2) return points[0];
  const score = (point: Landmark) =>
    (from ? Math.max(Math.abs(point.x - from.x), Math.abs(point.y - from.y)) : 0) + Math.random() * 60;
  return [...points].sort((a, b) => score(a) - score(b))[0];
}

// The town a resident is in or nearest to (by its nearest shop or bank, within 250 tiles), else its
// home town: shops, banks and shelter come from where it is, not from where it was born.
export function townAt(at: { x: number; y: number }, home: string): string {
  const tiles = (p: { x: number; y: number }) => Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y));
  return (
    [...catalog.values()]
      .flat()
      .filter((point) => tiles(point) < 250)
      .sort((a, b) => tiles(a) - tiles(b))[0]?.city ?? home
  );
}

export function serviceLocation(city: string, service: ServiceType): Landmark {
  const point = serviceLocations(city, service)[0];
  if (!point) throw new Error(`No ${service} landmark configured for ${city}`);
  return point;
}

// Named landmarks of a city matching `pattern` (inns and taverns for a resident's leisure).
export const cityLandmarks = (city: string, pattern: RegExp): { name: string; x: number; y: number }[] =>
  Object.entries(source)
    .find(([name]) => name.toLowerCase() === city.toLowerCase())?.[1]
    .filter((point) => pattern.test(point.name)) ?? [];
