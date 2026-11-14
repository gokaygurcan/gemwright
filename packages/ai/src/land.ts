import { join } from 'node:path';

import { moongateList } from '@gemwright/common/game/rules';

import { logger } from './log';
import { readShardWorld } from './spawns';
import { Terrain } from './terrain';
import { useShardAreas } from './v1/area-build';
import { useShardRoutes } from './v1/route-build';
import { useShardWorld } from './v1/shard-world';
import { buildWorkAreas } from './v1/work-area-build';
import { useCities } from './v1/world';
import { useLand } from './v2/reach';
import { confine, prepareArea } from './v2/shadow';
import { WalkGraph } from './walk-graph';
import { useWalkGraph } from './walk-graph-store';

// The world residents live in, from the data folder: the shard's spawners and world files, the map,
// and how the land joins up. Read before anyone wakes (serve.ts), and before a decision is
// simulated (v2/simulate-cli.ts), so both meet the same world.
export async function prepareLand(data: string, cities: string[] | undefined) {
  // The cities residents may go to (world.ts useCities): every city when unset.
  useCities(cities);
  confine(cities);
  // The shard's own spawners (the deployment's world files) decide where vendors stand and residents
  // hunt.
  const shardWorld = readShardWorld(join(data, 'world'));
  if (!shardWorld)
    throw new Error(
      `No world files in ${join(data, 'world')} (Spawns/ and Regions.xml): run gemwright shard deploy --ai to upload them.`
    );
  useShardWorld(shardWorld);
  logger('serve').info(`[serve] vendors and hunting grounds from ${shardWorld.spawners.length} spawners`);
  const terrain = Terrain.shared(join(data, 'assets'), 1);
  // Where each town's mines and woods lie, from the map.
  buildWorkAreas(terrain);
  // Which places can be walked to from which, and the public roads long walks follow: kept on the
  // volume, built again only for a new world or map.
  await useShardAreas(data, terrain, join(data, 'assets'), shardWorld.teleporters);
  useShardRoutes(data, terrain, join(data, 'assets'));
  // How the land joins up on foot, by teleporter and by moongate (walk-graph.ts), for the v2 mind.
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
