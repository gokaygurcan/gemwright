import { useShardSpawns } from './cemeteries';
import { useEscortSpawns } from './escort';
import { haven, useHaven } from './haven';
import { havenFromSpawners } from './haven-spawns';
import { useTeleporters } from './links';
import { useShardForges, useShardVendors, useTownSpawners, useTowns } from './locations';
import { useShardAnkhs } from './resurrection';
import type { ShardWorld } from './spawns';
import { useTamingSpawns } from './tamer-grounds';

// The shard's own world files (spawns.ts readShardWorld) decide, at start, the World layer: its towns,
// teleporters, forges and ankhs, where vendors stand, where creatures live (in towns,
// on Haven Island and overland), where tamable animals and escorts may be found. A spawner says what
// may be somewhere, not what is: what residents find there is theirs to learn.
export function useShardWorld(world: ShardWorld) {
  // Towns first: every place counts for its town by them.
  useTowns(world.towns);
  useTeleporters(world.teleporters);
  useShardVendors(world.spawners);
  useTownSpawners(world.spawners);
  useShardForges(world.decoration);
  useShardAnkhs(world.decoration);
  useHaven(world.named);
  const island = havenFromSpawners(world.spawners, haven.island, haven.town);
  haven.grounds.splice(0, haven.grounds.length, ...island.grounds);
  useShardSpawns(world);
  useTamingSpawns(world.spawners);
  useEscortSpawns(world.spawners);
}
