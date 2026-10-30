import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { GameFile } from '@gemwright/client/files';
import type { ShardConfig } from '@gemwright/common/config/types';

import { createManifest } from './client-files';
import { command } from './process';
import { required } from './required';
import { counterpart, ensureService, readState, type ServiceState } from './service';

interface Dependencies {
  loadShard: (directory: string) => Promise<ShardConfig>;
  stageImage: (image: 'ai' | 'client', context: string) => Promise<void>;
  progress?: (message: string) => void;
}
interface RemoteFile {
  name: string;
  size: number;
  type: string;
}
async function pendingUploads(files: GameFile[], volumeFlags: string[], run: <T>(args: string[]) => Promise<T>) {
  const directories = new Map<string, RemoteFile[]>();
  async function list(path: string): Promise<RemoteFile[]> {
    const cached = directories.get(path);
    if (cached) return cached;
    if (path !== '/' && !(await list(posix.dirname(path))).some((entry) => entry.name === posix.basename(path))) {
      directories.set(path, []);
      return [];
    }
    const remote = await run<{ files: RemoteFile[] }>([...volumeFlags, 'list', path, '--json']);
    directories.set(path, remote.files);
    return remote.files;
  }
  const pending: GameFile[] = [];
  for (const file of files) {
    const entries = await list(posix.join('/gamefiles', posix.dirname(file.path)));
    const stored = entries.find((entry) => entry.name === posix.basename(file.path));
    if (stored?.type !== 'file' || stored.size !== file.bytes) pending.push(file);
  }
  return pending;
}

export async function deployClient(
  dependencies: Dependencies,
  directory: string,
  assets: string,
  preparedFiles?: GameFile[]
) {
  const { loadShard, stageImage, progress = () => {} } = dependencies;
  directory = resolve(directory);
  assets = resolve(assets);
  const shard = await loadShard(directory);
  const run = async <T>(args: string[]): Promise<T> => JSON.parse(await command(['railway', ...args], directory));
  const target = await counterpart(directory, shard, run);
  const files = preparedFiles ?? (await createManifest(assets));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const statePath = join(directory, '.gemwright/webclient.json');
  const previous = await readState<ServiceState>(statePath);
  if (previous?.pendingAssets && previous.pendingAssets !== digest)
    throw new Error('A client import is pending with different game files. Resume with the original files first.');
  const resume = previous?.pendingAssets === digest;
  const context = await mkdtemp(join(tmpdir(), 'gemwright-web-deploy-'));
  try {
    await stageImage('client', context);
  } catch (error) {
    await rm(context, { recursive: true, force: true });
    throw error;
  }
  try {
    const { state, flags, save } = await ensureService(statePath, `${target.name}-web`, target, run);
    let origin = state.url;
    if (!origin) {
      const listed = await run<{ domains: { domain: string; targetPort?: number }[] }>([
        'domain',
        'list',
        ...flags,
        '--json'
      ]);
      const existing = listed.domains.filter((entry) => entry.targetPort === 3000);
      if (existing.length > 1)
        throw new Error('Multiple client domains match port 3000. Select one explicitly in the recorded state.');
      if (existing[0]) origin = `https://${existing[0].domain}`;
      else {
        const domain = await run<{ domain?: string }>(['domain', ...flags, '--port', '3000', '--json']);
        origin = domain.domain;
      }
      if (!origin) throw new Error('Railway did not return a public domain for the client.');
      state.url = origin;
      await save();
    }
    await run([
      'variable',
      'set',
      ...flags,
      `UO_HOST=${target.host}`,
      `UO_PORT=${target.port}`,
      'PORT=3000',
      `PUBLIC_ORIGIN=${origin}`,
      `SERVER_NAME=${shard.name}`,
      `UO_CLIENT_VERSION=${process.env.UO_CLIENT_VERSION ?? '7.0.45.1'}`,
      `UO_ENCRYPTION=${process.env.UO_ENCRYPTION ?? '0'}`,
      'RAILWAY_DOCKERFILE_PATH=Dockerfile',
      '--skip-deploys',
      '--json'
    ]);
    progress('Deploying the web client...');
    const upload = await command(
      ['railway', 'up', context, '--path-as-root', '--no-gitignore', ...flags, '--detach', '--json'],
      context
    );
    let deploymentId: string | undefined;
    for (const line of upload.split('\n')) {
      try {
        const value = JSON.parse(line);
        deploymentId = value.deploymentId ?? value.id ?? deploymentId;
      } catch {
        /* Railway also emits progress text. */
      }
    }
    if (!deploymentId)
      throw new Error('Railway returned no deployment ID. Inspect railway deployment list before retrying.');
    for (let attempt = 0; attempt < 120; attempt++) {
      const deployments = await run<{ id: string; status: string }[]>([
        'deployment',
        'list',
        ...flags,
        '--limit',
        '1',
        '--json'
      ]);
      const latest = deployments[0];
      const status = latest && (!deploymentId || latest.id === deploymentId) ? latest.status : undefined;
      if (status === 'SUCCESS') {
        if (state.assets !== digest) {
          const volumeFlags = ['volume', ...flags, 'files', '--volume', required(state.volume, 'Railway volume')];
          const pending = resume ? await pendingUploads(files, volumeFlags, run) : files;
          state.pendingAssets = digest;
          await save();
          progress(`Uploading ${pending.length} of ${files.length} game files to the web client's volume...`);
          const staging = join(directory, '.gemwright/webclient-files');
          const upload = join(staging, 'gamefiles');
          await rm(staging, { recursive: true, force: true });
          try {
            await mkdir(staging, { recursive: true });
            for (const file of pending) {
              const target = join(upload, file.path);
              await mkdir(dirname(target), { recursive: true });
              await link(join(assets, file.path), target).catch((error) => {
                if (error.code !== 'EXDEV') throw error;
                return copyFile(join(assets, file.path), target);
              });
            }
            const manifest = join(staging, 'manifest.json');
            await writeFile(manifest, `${JSON.stringify({ files })}\n`);
            if (pending.length)
              await run([
                'volume',
                ...flags,
                'files',
                '--volume',
                required(state.volume, 'Railway volume'),
                'upload',
                upload,
                '/',
                '--overwrite',
                '--concurrency',
                '1',
                '--json'
              ]);
            progress(`Verifying ${files.length} uploaded game files...`);
            for (const parent of new Set(files.map((file) => dirname(file.path)))) {
              const remote = await run<{ files: { name: string; size: number; type: string }[] }>([
                'volume',
                ...flags,
                'files',
                '--volume',
                required(state.volume, 'Railway volume'),
                'list',
                parent === '.' ? '/gamefiles' : `/gamefiles/${parent}`,
                '--json'
              ]);
              const stored = new Map(remote.files.map((file) => [file.name, file]));
              for (const file of files.filter((file) => dirname(file.path) === parent)) {
                const entry = stored.get(file.path.slice(parent === '.' ? 0 : parent.length + 1));
                if (entry?.type !== 'file' || entry.size !== file.bytes)
                  throw new Error(
                    `Incomplete game-file upload: ${file.path}. Rerun gemwright deploy --client to retry.`
                  );
              }
            }
            await run([
              'volume',
              ...flags,
              'files',
              '--volume',
              required(state.volume, 'Railway volume'),
              'upload',
              manifest,
              '/gamefiles/manifest.json',
              '--overwrite',
              '--json'
            ]);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
          state.assets = digest;
          delete state.pendingAssets;
          await save();
        }
        progress('Checking web client readiness...');
        const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10000) });
        if (!health.ok) throw new Error(`The deployed client health check returned ${health.status}.`);
        if ((await health.json()).ready !== true) throw new Error('The deployed web client is not ready.');
        progress(`Web client ready: ${origin}`);
        return origin;
      }
      if (status && ['FAILED', 'CRASHED', 'REMOVED'].includes(status))
        throw new Error(`Client deployment ${status.toLowerCase()}. Inspect: railway logs ${flags.join(' ')}.`);
      if (attempt % 6 === 0) progress(`Waiting for web client: ${status ?? 'pending'}...`);
      await sleep(5000);
    }
    throw new Error('Client deployment is still pending; rerun gemwright deploy --client to resume.');
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
