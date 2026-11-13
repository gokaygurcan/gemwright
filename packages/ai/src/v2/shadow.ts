import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { npcTypes } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { isAnkh } from '../decoration';
import { PathPool } from '../path-pool';
import { readShardWorld, type ShardWorld } from '../spawns';
import { Terrain } from '../terrain';
import { Atlas } from './atlas';
import type { History } from './history';
import { isForge } from './knowledge';
import { live } from './live';
import { Mind } from './mind';
import { perceive, screenOf } from './perceive';
import { Places } from './places';
import { landGraph } from './reach';
import { traitsOf } from './traits';
import { learnRoute } from './unreachable';

// The shard's world files beside the history (its data folder's `world`), read once.
const worlds = new Map<string, ShardWorld | undefined>();
const shardWorld = (history: string) => {
  const directory = join(dirname(history), 'world');
  if (!worlds.has(directory)) worlds.set(directory, readShardWorld(directory));
  return worlds.get(directory);
};

// The map of a shard's world, built once its walk graph is known (serve.ts loads it at start).
const atlases = new Map<string, Atlas>();
const atlasOf = (history: string) => {
  const world = shardWorld(history);
  if (!world) return undefined;
  const graph = landGraph();
  const directory = join(dirname(history), 'world');
  const known = atlases.get(directory);
  if (known) return known;
  const atlas = new Atlas(world.named, world.spawners, world.decoration, world.teleporters, graph);
  atlas.useRoads(PathPool.roads());
  // Without the walk graph yet, only its regions: built again once the graph is known.
  if (graph) atlases.set(directory, atlas);
  return atlas;
};

// The cities residents are kept to (gemwright.json ai.cities; serve.ts): every city when unset.
let confined: readonly string[] | undefined;
export const confine = (cities: readonly string[] | undefined) => {
  confined = cities;
};

const npcByName = new Map(npcTypes.map((type) => [type.toLowerCase(), type]));

// What the mind concludes rather than perceives: left out when it re-lives its history.
const concluded = [
  'predicted',
  'outcome',
  'considered',
  'drifted',
  'visited',
  'left',
  'lifetimes',
  'born',
  'trade',
  'looped'
];

// The v2 mind beside v1: it perceives and predicts what v1's attempts will bring, never acting.
export function shadow(session: PlayerSession, resident: string, history: History): () => void {
  return wake(session, resident, history).stop;
}

// The v2 mind living on its own (live.ts) until stopped or the session ends.
export async function act(
  session: PlayerSession,
  resident: string,
  history: History,
  stopping: () => boolean,
  trade: readonly string[] = [],
  supporting: readonly string[] = []
) {
  const { mind, ready, stop, terrain } = wake(session, resident, history, trade, supporting);
  let started = Date.now();
  const record = (kind: string, data: object) =>
    history.record({ resident, at: Date.now(), kind, data, ...where(session) });
  let failure: string | undefined;
  try {
    await ready;
    started = Date.now();
    mind.notice('training', { skills: supporting });
    record('life-started', { trade, goal: 'Gain wealth and trade skills while surviving' });
    mind.acting = true;
    // Where the shard places healers, ankhs and bankers in Trammel: where a ghost and a depositor go.
    // Only those within the cities it is kept to.
    const placed = (kind: string) =>
      (shardWorld(history.path)?.spawners ?? [])
        .filter((s) => s.map === 'Trammel' && s.kinds.some((k) => k.endsWith(kind)) && mind.allowed(s))
        .map(({ x, y }) => ({ x, y }));
    await live(
      session,
      mind,
      terrain,
      {
        shrines: [
          ...placed('healer').map((p) => ({ kind: 'healer' as const, ...p })),
          ...(shardWorld(history.path)?.decoration ?? [])
            .filter((p) => isAnkh(p.type) && mind.allowed(p))
            .map(({ x, y }) => ({ kind: 'ankh' as const, x, y }))
        ],
        bankers: placed('banker'),
        forges: (shardWorld(history.path)?.decoration ?? [])
          .filter((p) => isForge(p.graphic) && mind.allowed(p))
          .map((p) => ({ x: p.x, y: p.y, z: p.z, id: p.graphic })),
        // Vendors the shard places, by the kinds each spawner spawns (its type names as the wiki has them).
        vendors: (shardWorld(history.path)?.spawners ?? [])
          .filter((s) => s.map === 'Trammel' && mind.allowed(s))
          .map(({ x, y, kinds, range }) => ({ x, y, range, types: kinds.flatMap((k) => npcByName.get(k) ?? []) }))
          .filter((v) => v.types.length)
      },
      stopping,
      record
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    record('life-ended', {
      seconds: (Date.now() - started) / 1000,
      phase: session.phase,
      reason: failure ? 'failed' : stopping() ? 'stopped' : 'session ended',
      failure
    });
    stop();
  }
}

const where = (session: PlayerSession) => {
  const screen = screenOf(session);
  const p = screen.position;
  return p ? { where: { x: p.x, y: p.y, z: p.z, map: screen.map ?? 1 } } : {};
};

// On waking the mind re-lives its history in slices, yielding between them so the session keeps
// up; what happens meanwhile waits its turn, and nothing it concludes while re-living is written again.
const routesLoaded = new WeakSet<History>();

function wake(
  session: PlayerSession,
  resident: string,
  history: History,
  trade: readonly string[] = [],
  supporting: readonly string[] = []
) {
  if (!routesLoaded.has(history)) {
    for (const event of history.recent('route-failed', Date.now() - 2 * 3_600_000)) learnRoute(event, history.path);
    routesLoaded.add(history);
  }
  const write = (event: Parameters<History['record']>[0]) => history.record(event);
  const { traits, drawn } = traitsOf(history.read(resident, 'born'));
  if (drawn) write({ resident, at: Date.now(), kind: 'born', data: { traits } });
  // Its trade is part of who it is: recorded beside its traits whenever it is new or changed.
  const known = (history.read(resident, 'trade').at(-1) as { skills?: string[] } | undefined)?.skills;
  if (trade.length && JSON.stringify(known) !== JSON.stringify(trade))
    write({ resident, at: Date.now(), kind: 'trade', data: { skills: trade } });
  let awake = false;
  const mind = new Mind(
    resident,
    (event) => awake && write(event),
    traits,
    shardWorld(history.path)?.spawners,
    trade,
    supporting
  );
  mind.routeScope = history.path;
  mind.awake = false;
  const places = new Places(resident, write, {
    lifetimes: history.read(resident, 'lifetimes'),
    left: history.read(resident, 'left')
  });
  mind.places = places;
  mind.self.caps = shardWorld(history.path)?.caps;
  const through = history.latest();
  const compatibility = createHash('sha256')
    .update(
      JSON.stringify({
        version: 5,
        supporting,
        traits,
        trade,
        spawners: shardWorld(history.path)?.spawners
      })
    )
    .digest('hex');
  const saved = history.checkpoint<ReturnType<Mind['snapshot']>>(resident, compatibility);
  if (saved && saved.through <= through) mind.restore(saved.state);
  const after = saved && saved.through <= through ? saved.through : 0;
  const waiting: Parameters<History['record']>[0][] = [];
  // The map files beside the history; without them the land under the cursor stays unknown.
  const assets = join(dirname(history.path), 'assets');
  const mapped = existsSync(assets);
  // Residents live in Trammel, short of its far edges where the terrain reader stops.
  const landAt = (x: number, y: number, map: number | null) =>
    mapped && map === 1 && x < 7167 && y < 4095 ? Terrain.shared(assets, map).cell(x, y).land.id : undefined;
  const atlas = atlasOf(history.path);
  mind.atlas = atlas;
  if (atlas) mind.allowed = atlas.within(confined);
  const stop = perceive(
    session,
    resident,
    (event) => {
      history.record(event);
      places.observe(event);
      if (awake) mind.observe(event);
      else waiting.push(event);
    },
    landAt,
    atlas && ((p) => atlas.at(p))
  );
  const ready = (async () => {
    let count = 0;
    for (const event of history.lived(resident, through, concluded, after)) {
      mind.observe(event);
      if (++count % 5000 === 0) await Bun.sleep(0);
    }
    history.saveCheckpoint(resident, compatibility, through, mind.snapshot());
    awake = true;
    mind.awake = true;
    for (const event of waiting.splice(0)) mind.observe(event);
  })();
  return {
    mind,
    ready,
    terrain: mapped ? Terrain.shared(assets, 1) : undefined,
    stop: () => {
      stop();
      if (awake) history.saveCheckpoint(resident, compatibility, history.latest(), mind.snapshot());
      else history.flush();
    }
  };
}
