import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { LogParts } from '@gemwright/deployment/logs';
import { attachedCommand, command } from '@gemwright/deployment/process';
import { keepRetired, type PullParts, RETIRED } from '@gemwright/deployment/pull';
import { newestPull, type RestoreParts } from '@gemwright/deployment/restore';
import { loadShard } from '@gemwright/server/config';

import { dockerCompose, type LocalState, localRoot, readLocalState } from './local-deploy';
import { composeStatus, parseComposePs } from './status';

async function deployed(directory: string): Promise<{ root: string; state: LocalState }> {
  const state = await readLocalState(directory);
  if (!state?.parts.length)
    throw new Error('No local deployment found here. Run gemwright shard deploy --target local first.');
  await dockerCompose(directory);
  return { root: localRoot(directory), state };
}

const compose = (root: string, args: string[]) => command(['docker', 'compose', '-f', 'compose.json', ...args], root);

export async function localLogs(parts: LogParts, directory = process.cwd()) {
  const { root, state } = await deployed(directory);
  const all = !parts.server && !parts.client && !parts.ai;
  const selected = state.parts.filter((part) => all || parts[part]);
  for (const part of (['server', 'client', 'ai'] as const).filter((p) => parts[p] && !state.parts.includes(p)))
    console.error(`No local ${part} deployment is recorded here.`);
  if (!selected.length) throw new Error('None of the selected services is deployed here.');
  await attachedCommand(
    [
      'docker',
      'compose',
      '-f',
      'compose.json',
      'logs',
      '--timestamps',
      '--tail',
      '200',
      ...(parts.watch ? ['--follow'] : []),
      ...selected
    ],
    root
  );
}

// The same pull layout and manifest as Railway pulls, read straight from the local bind mounts.
export async function localPull(parts: PullParts, directory = process.cwd(), progress = console.log) {
  const { root, state } = await deployed(directory);
  const all = !parts.server && !parts.ai && !parts.logs;
  const want = { server: all || !!parts.server, ai: all || !!parts.ai, logs: all || !!parts.logs };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = parts.output ?? join(directory, '.gemwright/pulls', stamp);
  await mkdir(out, { recursive: true });
  const entries: { part: string; path: string; bytes?: number; error?: string }[] = [];
  const record = async (part: string, path: string, attempt: () => Promise<unknown>) => {
    try {
      await attempt();
      const info = await stat(join(out, path)).catch(() => undefined);
      entries.push({ part, path, bytes: info?.isFile() ? info.size : undefined });
      progress(`Pulled ${part}: ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ part, path, error: message });
      progress(`Could not pull ${part}: ${message}`);
    }
  };
  if (want.server && state.parts.includes('server'))
    for (const folder of ['Saves', 'Logs', ...(parts.backups ? ['Backups'] : [])])
      await record('server', `server/${folder}`, async () => {
        await mkdir(join(out, 'server'), { recursive: true });
        await compose(root, ['cp', `server:/app/data/server/${folder}`, join(out, 'server', folder)]);
      });
  else if (want.server && !all) progress('No local server is deployed here.');
  if (want.ai && state.parts.includes('ai')) {
    // A consistent copy made inside the running container, so a live write never tears it.
    const snapshot = `/tmp/pull-${stamp}.sqlite`;
    await record('ai', 'ai/residents.sqlite', async () => {
      try {
        await compose(root, [
          'exec',
          '-T',
          'ai',
          'bun',
          '-e',
          `new (require('bun:sqlite').Database)('/app/data/residents.sqlite').exec("VACUUM INTO '${snapshot}'")`
        ]);
        await mkdir(join(out, 'ai'), { recursive: true });
        await compose(root, ['cp', `ai:${snapshot}`, join(out, 'ai/residents.sqlite')]);
      } finally {
        await compose(root, ['exec', '-T', 'ai', 'rm', '-f', snapshot]).catch(() => undefined);
      }
    });
    await record('ai', 'ai/report.md', async () =>
      writeFile(
        join(out, 'ai/report.md'),
        `${await compose(root, ['exec', '-T', 'ai', 'bun', 'dist/report.js', '--db', '/app/data/residents.sqlite'])}\n`
      )
    );
    await record('ai', 'ai/retired.json', async () =>
      keepRetired(out, await compose(root, ['exec', '-T', 'ai', 'sh', '-c', RETIRED]))
    );
  } else if (want.ai && !all) progress('No local AI residents are deployed here.');
  if (want.logs) {
    await mkdir(join(out, 'logs'), { recursive: true });
    for (const part of state.parts.filter((p) => p !== 'client'))
      await record('logs', `logs/${part}.log`, async () =>
        writeFile(join(out, `logs/${part}.log`), `${await compose(root, ['logs', '--tail', '5000', part])}\n`)
      );
  }
  await writeFile(
    join(out, 'manifest.json'),
    `${JSON.stringify({ pulledAt: new Date().toISOString(), entries }, null, 2)}\n`
  );
  if (parts.cleanup && !parts.output && entries.every((entry) => !entry.error)) {
    const pulls = join(directory, '.gemwright/pulls');
    const older = (await readdir(pulls)).filter((name) => name !== stamp);
    for (const name of older) await rm(join(pulls, name), { recursive: true, force: true });
    if (older.length) progress(`Removed ${older.length} older pull${older.length === 1 ? '' : 's'}.`);
  }
  const failed = entries.filter((entry) => entry.error).length;
  progress(`\nSaved to ${out} (${entries.length - failed} pulled${failed ? `, ${failed} failed` : ''}).`);
}

// Restored files go to restore/ on the bind mounts; each start script swaps them in on boot and
// keeps the replaced ones (Saves.before-restore, residents.sqlite.before-restore).
// The pull to restore and which of its parts, checked before anything changes.
export async function restoreSelection(parts: RestoreParts, directory: string) {
  const source = parts.from ? resolve(directory, parts.from) : await newestPull(directory);
  const saves = join(source, 'server/Saves');
  const database = join(source, 'ai/residents.sqlite');
  const retired = join(source, 'ai/retired.json');
  const all = !parts.server && !parts.ai;
  const want = {
    server: (all || !!parts.server) && existsSync(join(saves, 'Mobiles')),
    ai: (all || !!parts.ai) && existsSync(database)
  };
  if (parts.server && !want.server) throw new Error(`The pull has no world saves: ${saves}`);
  if (parts.ai && !want.ai) throw new Error(`The pull has no resident database: ${database}`);
  if (!want.server && !want.ai) throw new Error(`Nothing to restore in ${source}.`);
  if (want.server && (await loadShard(directory)).emulator !== 'servuo')
    throw new Error('Restoring world saves supports ServUO shards only.');
  return { source, saves, database, retired, want };
}

export async function localRestore(
  parts: RestoreParts,
  confirm: () => Promise<boolean>,
  directory = process.cwd(),
  progress = console.log
) {
  const { root, state } = await deployed(directory);
  const { source, saves, database, retired, want } = await restoreSelection(parts, directory);
  if (want.server && !state.parts.includes('server')) throw new Error('No local server is deployed here.');
  if (want.ai && !state.parts.includes('ai')) throw new Error('No local AI residents are deployed here.');
  progress(`Restoring from ${source}:`);
  if (want.server)
    progress(
      '- world saves: the local shard restarts and the world returns to this save (current: Saves.before-restore).'
    );
  if (want.ai)
    progress(
      '- resident database: the AI service restarts with these residents (current: residents.sqlite.before-restore).'
    );
  if (!parts.yes && !(await confirm())) {
    progress('Nothing was restored.');
    return;
  }
  // Everything is copied before anything restarts, so a failed copy changes nothing.
  const stage = (service: string, from: string, names: string[]) =>
    compose(root, [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'sh',
      '-v',
      `${from}:/upload:ro`,
      service,
      '-c',
      `rm -rf /app/data/restore /app/data/restore.next && mkdir -p /app/data/restore.next && ${names.map((name) => `cp -a /upload/${name} /app/data/restore.next/`).join(' && ')} && mv /app/data/restore.next /app/data/restore`
    ]);
  if (want.server) await stage('server', dirname(saves), ['Saves']);
  if (want.ai)
    await stage('ai', dirname(database), ['residents.sqlite', ...(existsSync(retired) ? ['retired.json'] : [])]);
  const restart = [...(want.server ? ['server'] : []), ...(want.ai ? ['ai'] : [])];
  progress(`Restarting ${restart.join(' and ')}...`);
  await attachedCommand(['docker', 'compose', '-f', 'compose.json', 'restart', ...restart], root);
  progress('Restored. Each service swaps the restored files in as it starts.');
}

// Stopped containers keep their data volumes; start resumes them without rebuilding.
export async function localPower(action: 'stop' | 'start', parts: LogParts, directory = process.cwd()) {
  const { root, state } = await deployed(directory);
  const all = !parts.server && !parts.client && !parts.ai;
  const selected = state.parts.filter((part) => all || parts[part]);
  if (!selected.length) throw new Error('None of the selected services is deployed here.');
  await attachedCommand(['docker', 'compose', '-f', 'compose.json', action, ...selected], root);
}

export async function localStatus(parts: LogParts, directory = process.cwd()) {
  const { root, state } = await deployed(directory);
  const all = !parts.server && !parts.client && !parts.ai;
  const selected = state.parts.filter((part) => all || parts[part]);
  return composeStatus(selected, parseComposePs(await compose(root, ['ps', '--all', '--format', 'json'])));
}
