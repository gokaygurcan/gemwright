import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';
import { loadSave, saveFormat } from '@gemwright/common/saves';
import { savedDecoration, savedSpawnersXml } from '@gemwright/common/saves/world-files';
import { deployAi as deploy } from '@gemwright/deployment/ai-deploy';
import { pull } from '@gemwright/deployment/pull';
import { loadShard } from '@gemwright/server/config';
import { checkoutPaths } from '@gemwright/server/emulators/source';

import { stageImage } from './assets';

// Where the AI residents learn the land from: a world save (`--world <path>`), a fresh one pulled
// from the server (`--world-pull`), or by default the spawner files `[createworld` loads.
export interface WorldSource {
  saves?: string;
  pull?: boolean;
}

// The Saves folder of a pull, a server folder or the Saves folder itself.
function savesFolder(path: string): string {
  return [join(path, 'server/Saves'), join(path, 'Saves')].find((folder) => saveFormat(folder)) ?? path;
}

// The world files the AI residents learn the land from, staged in a folder of their own: the
// spawners and Trammel's fixed items (from a save, else the shard folder's own Spawns/,
// RevampedSpawns/ and Data/Decoration, else those of the ServUO revision the shard runs, by a sparse
// checkout of just those paths), Data/Regions.xml and the teleporters (Data/teleporters.csv).
export async function shardWorldFiles(directory: string, shard: ShardConfig, from: WorldSource = {}): Promise<string> {
  const staged = await mkdtemp(join(tmpdir(), 'gemwright-ai-world-'));
  let source: string | undefined;
  try {
    let saves = from.saves && savesFolder(resolve(from.saves));
    if (from.pull) {
      const output = join(directory, '.gemwright/pulls', new Date().toISOString().replace(/[:.]/g, '-'));
      await pull({ server: true, output }, directory, console.log);
      saves = savesFolder(output);
    }
    const spawns = saves ? [] : ['Spawns', 'RevampedSpawns'];
    // Trammel's decoration: Britannia (both facets), Trammel's own and Magincia's Trammel side.
    const decoration = saves
      ? []
      : ['Britannia', 'Trammel', 'Magincia/Trammel'].map((folder) => `Data/Decoration/${folder}`);
    const data = ['Data/Regions.xml', 'Data/teleporters.csv', ...decoration];
    const own = (path: string) => existsSync(join(directory, path));
    const needs = [...spawns, ...data].filter((path) => !own(path));
    if (needs.length) {
      if (!shard.source) throw new Error('The shard records no ServUO source to read its world files from.');
      source = await mkdtemp(join(tmpdir(), 'gemwright-ai-source-'));
      await checkoutPaths(source, shard.source, needs);
    }
    const located = (path: string) => join(own(path) ? directory : (source as string), path);
    await mkdir(join(staged, 'Spawns'));
    await mkdir(join(staged, 'Decoration'));
    if (saves) {
      const world = loadSave(saves);
      const spawners = savedSpawnersXml(world);
      const fixed = savedDecoration(world);
      await writeFile(join(staged, 'Spawns/world.xml'), spawners.xml);
      await writeFile(join(staged, 'Decoration/world.cfg'), fixed.cfg);
      console.log(
        `Read ${spawners.spawners} spawners and ${fixed.placements} fixed items from the world save in ${saves}.`
      );
    }
    for (const folder of spawns)
      if (existsSync(located(folder))) await cp(located(folder), join(staged, 'Spawns', folder), { recursive: true });
    await cp(located('Data/Regions.xml'), join(staged, 'Regions.xml'));
    await cp(located('Data/teleporters.csv'), join(staged, 'teleporters.csv'));
    for (const folder of decoration)
      await cp(located(folder), join(staged, folder.replace('Data/', '')), { recursive: true });
    return staged;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  } finally {
    if (source) await rm(source, { recursive: true, force: true });
  }
}

export function deployAi(directory: string, gameFiles: string, stage = stageImage, world: WorldSource = {}) {
  return deploy(
    {
      loadShard,
      stageImage: stage,
      worldFiles: (dir, shard) => shardWorldFiles(dir, shard, world),
      progress: console.log
    },
    directory,
    gameFiles
  );
}
