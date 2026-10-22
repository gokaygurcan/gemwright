import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type Gate, moongates } from './moongate';
import { distance } from './navigation';
import { RouteSearch } from './path-search';
import { type Point, Terrain } from './terrain';

// Offline build of catalogs/dungeons.json from the pinned ServUO source (Data/Regions.xml,
// Data/teleporters.csv, Spawns/trammel.xml) and the client map files. Floors are the walkable
// components of each dungeon; stairs are teleporter groups joining them; rooms are spawner sites.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { servuo: { type: 'string' }, assets: { type: 'string' }, output: { type: 'string' } }
});
if (!values.servuo || !values.assets || !values.output) throw new Error('--servuo, --assets and --output are required');
const servuo = resolve(values.servuo);
const terrain = Terrain.shared(resolve(values.assets), 1);
const maxFloorTiles = 200000;
// The larger workspace is only for this offline public-map build, never for live sessions.
const search = new RouteSearch(1048576, 20000, 2000000);
const gateOf = new Map<string, Gate | null>();
// The public moongate a resident walks to an entrance from: the nearest one with a walking route,
// so an island gate (Skara Brae) is skipped for a mainland dungeon. Null when no gate reaches it
// (Deceit, Hythloth and Fire need a boat or Recall).
function walkingGate(at: Point): Gate | null {
  const key = `${Math.round(at.x / 8)},${Math.round(at.y / 8)}`;
  if (gateOf.has(key)) return gateOf.get(key) ?? null;
  const gates = (Object.keys(moongates) as Gate[]).sort(
    (a, b) => distance(at, moongates[a]) - distance(at, moongates[b])
  );
  const gate =
    gates.find((g) => search.run(terrain, { start: moongates[g], goal: at, range: 1, blocked: [] }).path) ?? null;
  gateOf.set(key, gate);
  return gate;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Dungeon {
  name: string;
  rects: Rect[];
  entrance: Point;
}
interface Link {
  from: Point;
  to: Point;
}

const inside = (rects: Rect[], p: { x: number; y: number }) =>
  rects.some((r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height);
const attr = (tag: string, name: string) => Number(new RegExp(`${name}="(-?\\d+)"`).exec(tag)?.[1]);

function readDungeons(): Dungeon[] {
  const xml = readFileSync(join(servuo, 'Data/Regions.xml'), 'utf8');
  const trammel = xml.slice(xml.indexOf('<Facet name="Trammel">'), xml.indexOf('<Facet name="Ilshenar">'));
  const dungeons: Dungeon[] = [];
  for (const [, name, body] of trammel.matchAll(
    /<region type="DungeonRegion"[^>]*name="([^"]+)">([\s\S]*?)<\/region>/g
  )) {
    const entrance = /<entrance [^>]*>/.exec(body ?? '')?.[0];
    if (!name || !body || !entrance) continue;
    // Nested sub-regions repeat rects of their own dungeon; only the outer ones are needed.
    const outer = body.split('<region')[0] ?? '';
    const rects = [...outer.matchAll(/<rect [^>]*>/g)].map(([tag]) =>
      tag.includes('x1=')
        ? {
            x: attr(tag, 'x1'),
            y: attr(tag, 'y1'),
            width: attr(tag, 'x2') - attr(tag, 'x1'),
            height: attr(tag, 'y2') - attr(tag, 'y1')
          }
        : { x: attr(tag, 'x'), y: attr(tag, 'y'), width: attr(tag, 'width'), height: attr(tag, 'height') }
    );
    const go = /<go [^>]*>/.exec(outer)?.[0] ?? '';
    dungeons.push({ name, rects, entrance: { x: attr(entrance, 'x'), y: attr(entrance, 'y'), z: attr(go, 'z') } });
  }
  return dungeons;
}

// Visible moongate-style gates placed by Scripts/Services/Revamped Dungeons/DespiseRevamped/Setup.cs;
// each pair runs both ways. They join Despise's upper levels to the revamped lower level.
const despiseGates: [Point, Point][] = [
  [
    { x: 5458, y: 610, z: 50 },
    { x: 5476, y: 737, z: 5 }
  ],
  [
    { x: 5460, y: 523, z: 60 },
    { x: 5460, y: 675, z: 20 }
  ],
  [
    { x: 5387, y: 628, z: 30 },
    { x: 5388, y: 753, z: 5 }
  ]
];

function readLinks(): Link[] {
  const links: Link[] = despiseGates.flatMap(([a, b]) => [
    { from: a, to: b },
    { from: b, to: a }
  ]);
  for (const line of readFileSync(join(servuo, 'Data/teleporters.csv'), 'utf8').split('\n')) {
    const f = line.trim().split(',');
    if (line.startsWith('#') || f.length < 9 || f[3] === 'Felucca' || f[7] === 'Felucca') continue;
    if (f[3] !== 'Trammel' || f[7] !== 'Trammel') continue;
    const [x, y, z, , dx, dy, dz, , back] = f;
    const from = { x: Number(x), y: Number(y), z: Number(z) };
    const to = { x: Number(dx), y: Number(dy), z: Number(dz) };
    links.push({ from, to });
    if (back === 'True') links.push({ from: to, to: from });
  }
  return links;
}

interface Site {
  name: string;
  x: number;
  y: number;
  z: number;
  range: number;
  monsters: { type: string; max: number }[];
}

function readSites(): Site[] {
  const xml = readFileSync(join(servuo, 'Spawns/trammel.xml'), 'utf8');
  const sites: Site[] = [];
  for (const [block] of xml.matchAll(/<Points>[\s\S]*?<\/Points>/g)) {
    const get = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? '';
    const monsters = get('Objects2')
      .split(':OBJ=')
      .map((entry) => ({ type: entry.split(':')[0] ?? '', max: Number(/MX=(\d+)/.exec(entry)?.[1] ?? 1) }))
      .filter((m) => m.type && !/^treasure/i.test(m.type));
    if (!monsters.length) continue;
    const width = Number(get('Width'));
    const height = Number(get('Height'));
    sites.push({
      name: get('Name'),
      x: Number(get('CentreX')),
      y: Number(get('CentreY')),
      z: Number(get('CentreZ')),
      range: Math.max(Number(get('Range')), Math.ceil(Math.max(width, height) / 2)),
      monsters
    });
  }
  return sites;
}

// Flood-fills walkable tiles inside the dungeon from a seed; every tile records its floor id.
function floorOf(seed: Point, rects: Rect[], floors: Map<string, number>, next: () => number): number | null {
  const start = terrain.stand(seed.x, seed.y, seed.z);
  if (!start) return null;
  // Levels can overlap at different heights, so a tile is keyed by its standing z too.
  const key = (p: Point) => `${p.x},${p.y},${p.z}`;
  const known = floors.get(key(start));
  if (known !== undefined) return known;
  const id = next();
  const queue: Point[] = [start];
  floors.set(key(start), id);
  for (let i = 0; i < queue.length && i < maxFloorTiles; i++) {
    const at = queue[i] as Point;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const step = { x: at.x + dx, y: at.y + dy };
        if (!inside(rects, step)) continue;
        const stood = terrain.stand(step.x, step.y, at.z, at);
        if (!stood || floors.has(key(stood))) continue;
        floors.set(key(stood), id);
        queue.push(stood);
      }
  }
  return id;
}

const links = readLinks();
const sites = readSites();
const catalog = readDungeons().map((dungeon) => {
  const floors = new Map<string, number>();
  let count = 0;
  const next = () => count++;
  const ours = links.filter((l) => inside(dungeon.rects, l.from) || inside(dungeon.rects, l.to));
  const entry = ours.filter((l) => !inside(dungeon.rects, l.from) && inside(dungeon.rects, l.to));
  const stairs = ours
    .filter((l) => inside(dungeon.rects, l.from))
    .map((l) => ({
      ...l,
      floor: floorOf(l.from, dungeon.rects, floors, next),
      toFloor: inside(dungeon.rects, l.to) ? floorOf(l.to, dungeon.rects, floors, next) : null
    }));
  const rooms = sites
    .filter((s) => inside(dungeon.rects, s))
    .map((s) => ({ ...s, floor: floorOf(s, dungeon.rects, floors, next) }));
  // Depth: stair hops from the floors the surface entrances land on.
  const depth = new Map<number, number>();
  // A walk-in dungeon (Terathan Keep) has its surface entrance inside its own bounds.
  const walkIn = inside(dungeon.rects, dungeon.entrance)
    ? [floorOf(dungeon.entrance, dungeon.rects, floors, next)]
    : [];
  let frontier = [...entry.map((l) => floorOf(l.to, dungeon.rects, floors, next)), ...walkIn].filter((f) => f !== null);
  for (let d = 0; frontier.length; d++) {
    for (const f of frontier) depth.set(f, d);
    frontier = stairs
      .filter((s) => s.floor !== null && depth.has(s.floor) && s.toFloor !== null && !depth.has(s.toFloor))
      .map((s) => s.toFloor as number);
  }
  // Adjacent teleporter tiles with one destination floor are one stairway.
  const groups: { floor: number | null; toFloor: number | null; tiles: Link[] }[] = [];
  for (const s of stairs) {
    const group = groups.find(
      (g) =>
        g.floor === s.floor &&
        g.toFloor === s.toFloor &&
        g.tiles.some((t) => Math.abs(t.from.x - s.from.x) <= 1 && Math.abs(t.from.y - s.from.y) <= 1)
    );
    if (group) group.tiles.push(s);
    else groups.push({ floor: s.floor, toFloor: s.toFloor, tiles: [s] });
  }
  // Floors no entrance or stairway reaches (event areas such as revamped Despise's lower level) are left out.
  const used = [...new Set<number | null>([...rooms.map((r) => r.floor), ...groups.map((g) => g.floor)])].filter(
    (f): f is number => f !== null && depth.has(f)
  );
  return {
    name: dungeon.name,
    entrance: dungeon.entrance,
    entries: entry
      .map((l) => ({
        from: l.from,
        to: l.to,
        floor: floorOf(l.to, dungeon.rects, floors, next),
        gate: walkingGate(l.from)
      }))
      .filter((e) => e.gate !== null),
    floors: used.map((id) => ({
      id,
      depth: depth.get(id),
      stairs: groups
        .filter((g) => g.floor === id)
        .map((g) => ({ at: g.tiles[0]?.from, to: g.tiles[0]?.to, toFloor: g.toFloor, width: g.tiles.length })),
      rooms: rooms
        .filter((r) => r.floor === id)
        .map(({ name, x, y, z, range, monsters }) => ({ name, at: { x, y, z }, range, monsters }))
    }))
  };
});

// One file per dungeon keeps each catalog small enough to read and review.
mkdirSync(resolve(values.output), { recursive: true });
for (const dungeon of catalog) {
  const file = `${dungeon.name.toLowerCase().replace(/[^a-z]+/g, '-')}.json`;
  const source =
    'ServUO Data/Regions.xml, Data/teleporters.csv, Spawns/trammel.xml, DespiseRevamped/Setup.cs; client map files';
  writeFileSync(join(resolve(values.output), file), `${JSON.stringify({ schemaVersion: 1, source, ...dungeon })}\n`);
}
