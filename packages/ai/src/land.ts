import { join } from 'node:path';

import { moongateList } from '@gemwright/common/game/rules';

import { logger } from './log';
import { useLand } from './reach';
import { useRoutes } from './routes';
import { confine, prepareArea } from './shadow';
import { readShardWorld } from './spawns';
import { Terrain } from './terrain';
import { WalkGraph } from './walk-graph';
import { useWalkGraph } from './walk-graph-store';
import { checkCities } from './world';

// The world residents live in, from the data folder: the shard's spawners and world files, the map,
// and how the land joins up. Read before anyone wakes (serve.ts), and before a decision is
// simulated (simulate-cli.ts), so both meet the same world.
export async function prepareLand(data: string, cities: string[] | undefined) {
  // The cities residents are kept to: every city when unset.
  checkCities(cities);
  confine(cities);
  // The shard's own world files: spawners, regions, teleporters.
  const shardWorld = readShardWorld(join(data, 'world'));
  if (!shardWorld)
    throw new Error(
      `No world files in ${join(data, 'world')} (Spawns/ and Regions.xml): run gemwright shard deploy --ai to upload them.`
    );
  logger('serve').info(`[serve] ${shardWorld.spawners.length} spawners in the world files`);
  const terrain = Terrain.shared(join(data, 'assets'), 1);
  // The public roads long walks follow: kept on the volume, walked again only for new ends or a new map.
  useRoutes(data, shardWorld, terrain, join(data, 'assets'), cities);
  // How the land joins up on foot, by teleporter and by moongate (walk-graph.ts), for the mind.
  const teleporters = shardWorld.teleporters;
  useLand(
    new WalkGraph(
      await useWalkGraph(data, terrain, join(data, 'assets'), teleporters, moongateList),
      terrain,
      new Set(teleporters.map((l) => l.from.x * 4096 + l.from.y))
    )
  );
  // What the cities residents are kept to hold, listed before anyone wakes.
  prepareArea(join(data, 'history.sqlite'), terrain);
}
