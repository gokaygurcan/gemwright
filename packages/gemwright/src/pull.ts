import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runCommand } from './process';

// gemwright pull: a shard's state saved locally on demand. The server's world saves and accounts
// (Saves) and its logs (Logs), ServUO's own Backups when asked; the AI residents database as a
// consistent snapshot (VACUUM INTO inside the container, so a live write never tears it) with the
// population report; and recent service logs. Everything lands in .gemwright/pulls/<time>/ with
// a manifest of what came down and what failed. Railway volumes are read with `railway volume
// files download`, a VPS over SSH as one tar archive. Client files are never pulled: they are
// large and re-imported from the original UO files.
export interface PullParts {
  server?: boolean;
  ai?: boolean;
  logs?: boolean;
  backups?: boolean;
  output?: string;
  // After a complete pull into .gemwright/pulls, delete every older pull there.
  cleanup?: boolean;
}
interface Entry {
  part: string;
  path?: string;
  bytes?: number;
  error?: string;
}

export async function pull(parts: PullParts, directory = process.cwd()): Promise<void> {
  const all = !parts.server && !parts.ai && !parts.logs;
  const want = { server: all || !!parts.server, ai: all || !!parts.ai, logs: all || !!parts.logs };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = parts.output ?? join(directory, '.gemwright/pulls', stamp);
  await mkdir(out, { recursive: true });
  const entries: Entry[] = [];
  const record = async (part: string, path: string, attempt: () => Promise<unknown>) => {
    try {
      await attempt();
      entries.push({ part, path, bytes: await size(join(out, path)) });
      console.log(`Pulled ${part}: ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ part, path, error: message });
      console.log(`Could not pull ${part}: ${message}`);
    }
  };

  const vps = await readJson<{ target?: string; ssh?: string; remotePath?: string }>(
    join(directory, '.gemwright/deployment.json')
  );
  if (vps?.target === 'vps') {
    const { ssh, remotePath } = vps;
    if (!ssh || !remotePath) throw new Error('This VPS deployment has no SSH destination to pull from.');
    if (want.server) {
      const folders = ['server/Saves', 'server/Logs', ...(parts.backups ? ['server/Backups'] : [])];
      await record('server', 'server.tar.gz', () =>
        toFile(
          ['ssh', ssh, `tar czf - -C ${quote(`${remotePath}/data`)} ${folders.map(quote).join(' ')}`],
          join(out, 'server.tar.gz')
        )
      );
    }
    if (want.ai || want.logs) console.log('AI residents and service logs are pulled from Railway deployments only.');
  } else {
    const state = await readJson<{ project?: string; environment?: string; service?: string; volume?: string }>(
      join(directory, '.gemwright/railway.json')
    );
    const serverVolume = state?.volume;
    if (!state?.project || !serverVolume) throw new Error('No deployment found here: run gemwright deploy first.');
    const scope = ['--project', state.project, '--environment', state.environment ?? 'production'];
    const ai = await readJson<{ service?: string; volume?: string }>(join(directory, '.gemwright/ai.json'));
    // The local folder must exist: Railway downloads into it but does not create it.
    const download = async (volume: string, from: string, to: string) => {
      await mkdir(dirname(join(out, to)), { recursive: true });
      return railway(
        ['volume', ...scope, 'files', '--volume', volume, 'download', from, join(out, to), '--json'],
        directory
      );
    };

    if (want.server) {
      for (const folder of ['Saves', 'Logs', ...(parts.backups ? ['Backups'] : [])])
        await record('server', `server/${folder}`, () =>
          download(serverVolume, `/server/${folder}`, `server/${folder}`)
        );
    }
    const aiService = ai?.service;
    const aiVolume = ai?.volume;
    if (want.ai && aiService && aiVolume) {
      // A consistent copy made in the container's temporary folder (never on the volume), streamed
      // back over SSH as base64 and removed there in the same command.
      const snapshot = `/tmp/pull-${stamp}.sqlite`;
      const target = join(out, 'ai/residents.sqlite');
      const made = await railway(
        [
          'ssh',
          ...scope,
          '--service',
          aiService,
          `cd /app/data && bun -e "new (require('bun:sqlite').Database)('residents.sqlite').exec(\\"VACUUM INTO '${snapshot}'\\")" && base64 ${snapshot}; rm -f ${snapshot}`
        ],
        directory
      ).then(
        async (encoded) => {
          const bytes = Buffer.from(encoded.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
          if (!bytes.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) return false;
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          return true;
        },
        () => false
      );
      if (made) {
        entries.push({ part: 'ai', path: 'ai/residents.sqlite', bytes: await size(target) });
        console.log('Pulled ai: ai/residents.sqlite');
      } else {
        // Without a snapshot: the database with its write-ahead log, which SQLite replays on open.
        for (const file of ['residents.sqlite', 'residents.sqlite-wal'])
          await record('ai', `ai/${file}`, () => download(aiVolume, `/${file}`, `ai/${file}`));
      }
      await record('ai', 'ai/report.md', async () => {
        const report = await railway(
          [
            'ssh',
            ...scope,
            '--service',
            aiService,
            'cd /app && bun packages/ai/src/report.ts --db /app/data/residents.sqlite'
          ],
          directory
        );
        await writeFile(join(out, 'ai/report.md'), `${report}\n`);
      });
    } else if (want.ai && !all) console.log('No AI residents are deployed here.');
    if (want.logs) {
      await mkdir(join(out, 'logs'), { recursive: true });
      for (const [part, service] of [
        ['server', state.service],
        ['ai', ai?.service]
      ] as const) {
        if (!service) continue;
        await record('logs', `logs/${part}.log`, async () => {
          const logs = await railway(['logs', ...scope, '--service', service, '--lines', '5000'], directory);
          await writeFile(join(out, `logs/${part}.log`), `${logs}\n`);
        });
      }
    }
  }
  await writeFile(
    join(out, 'manifest.json'),
    `${JSON.stringify({ pulledAt: new Date().toISOString(), entries }, null, 2)}\n`
  );
  // Only a complete pull replaces the older ones: a failed part would otherwise lose the last good copy.
  if (parts.cleanup && !parts.output && entries.every((entry) => !entry.error)) {
    const pulls = join(directory, '.gemwright/pulls');
    const older = (await readdir(pulls)).filter((name) => name !== stamp);
    for (const name of older) await rm(join(pulls, name), { recursive: true, force: true });
    if (older.length) console.log(`Removed ${older.length} older pull${older.length === 1 ? '' : 's'}.`);
  }
  const failed = entries.filter((e) => e.error).length;
  console.log(`\nSaved to ${out} (${entries.length - failed} pulled${failed ? `, ${failed} failed` : ''}).`);
}

export async function railway(args: string[], directory: string): Promise<string> {
  const { code, stdout, stderr } = await runCommand(['railway', ...args], directory);
  // The whole message: Railway's reason can come before a closing hint line.
  if (code !== 0)
    throw new Error(
      stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('> Select'))
        .join(' ') ||
        stdout ||
        `railway ${args[0]} failed`
    );
  return stdout;
}

// Streams a command's output into a file (a remote tar archive over SSH).
function toFile(args: string[], path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [program, ...rest] = args;
    if (!program) return reject(new Error('Nothing to run'));
    const child = spawn(program, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.pipe(createWriteStream(path));
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`))));
  });
}

async function size(path: string): Promise<number | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? info.size : undefined;
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  return readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as T,
    () => undefined
  );
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
