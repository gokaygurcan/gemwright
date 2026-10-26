import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import * as prompts from '@clack/prompts';

import { loadShard } from './config';
import { railway, readJson } from './pull';

// gemwright restore: puts a pull (gemwright pull) back on a Railway deployment. The world saves go
// to the shard's volume and the resident database to the AI's, each into restore/ while the
// services keep running; then each service restarts and its start script swaps the restored files
// in on boot, after the previous process has stopped and written its last save. The replaced files
// stay on the volume (server/Saves.before-restore, residents.sqlite.before-restore). Restoring the
// world turns the shard back to that save and disconnects everyone, so it always asks first.
export interface RestoreParts {
  from?: string;
  server?: boolean;
  ai?: boolean;
  yes?: boolean;
}

async function newestPull(directory: string) {
  const pulls = join(directory, '.gemwright/pulls');
  const stamps = existsSync(pulls) ? (await readdir(pulls)).sort().reverse() : [];
  const found = stamps
    .map((stamp) => join(pulls, stamp))
    .find((path) => existsSync(join(path, 'server/Saves/Mobiles')) || existsSync(join(path, 'ai/residents.sqlite')));
  if (!found) throw new Error('No pull to restore here: run gemwright pull first, or pass --from <pull folder>.');
  return found;
}

export async function restore(
  parts: RestoreParts,
  directory = process.cwd(),
  run: (args: string[], directory: string) => Promise<string> = railway
): Promise<void> {
  const source = parts.from ? resolve(directory, parts.from) : await newestPull(directory);
  const saves = join(source, 'server/Saves');
  const database = join(source, 'ai/residents.sqlite');
  const all = !parts.server && !parts.ai;
  const want = {
    server: (all || !!parts.server) && existsSync(join(saves, 'Mobiles')),
    ai: (all || !!parts.ai) && existsSync(database)
  };
  if (parts.server && !want.server) throw new Error(`The pull has no world saves: ${saves}`);
  if (parts.ai && !want.ai) throw new Error(`The pull has no resident database: ${database}`);
  if (!want.server && !want.ai) throw new Error(`Nothing to restore in ${source}.`);

  const shard = await loadShard(directory);
  if (want.server && shard.emulator !== 'servuo') throw new Error('Restoring world saves supports ServUO shards only.');
  const state = await readJson<{ project?: string; environment?: string; service?: string; volume?: string }>(
    join(directory, '.gemwright/railway.json')
  );
  const ai = await readJson<{ service?: string; volume?: string }>(join(directory, '.gemwright/ai.json'));
  if (!state?.project || !state.service || !state.volume)
    throw new Error('No Railway deployment found here: restore works on Railway deployments.');
  if (want.ai && (!ai?.service || !ai.volume)) throw new Error('No AI residents are deployed here.');

  console.log(`Restoring from ${source}:`);
  if (want.server)
    console.log(
      '- world saves: the shard restarts, every connected player is disconnected, and the world returns to this save. The current saves are kept on the volume as server/Saves.before-restore.'
    );
  if (want.ai)
    console.log(
      '- resident database: the AI service restarts with these residents. The current database is kept as residents.sqlite.before-restore.'
    );
  if (!parts.yes) {
    if (!process.stdin.isTTY) throw new Error('Restore changes the live shard: rerun with --yes to confirm.');
    const confirmed = await prompts.confirm({ message: 'Restore now?', initialValue: false });
    if (prompts.isCancel(confirmed) || !confirmed) {
      console.log('Nothing was restored.');
      return;
    }
  }

  const scope = ['--project', state.project, '--environment', state.environment ?? 'production'];
  const upload = (volume: string, from: string, to: string) =>
    run(['volume', ...scope, 'files', '--volume', volume, 'upload', from, to, '--overwrite', '--json'], directory);
  const restart = (service: string) => run(['restart', ...scope, '--service', service, '--yes', '--json'], directory);

  // Everything is uploaded before anything restarts, so a failed upload changes nothing.
  if (want.server) {
    console.log('Uploading the world saves...');
    await upload(state.volume, saves, '/restore/Saves');
  }
  if (want.ai && ai?.volume) {
    console.log('Uploading the resident database...');
    await upload(ai.volume, database, '/restore/residents.sqlite');
  }
  if (want.server) {
    console.log('Restarting the shard...');
    await restart(state.service);
  }
  if (want.ai && ai?.service) {
    console.log('Restarting the AI residents...');
    await restart(ai.service);
  }
  console.log('Restored. Each service swaps the restored files in as it starts.');
}
