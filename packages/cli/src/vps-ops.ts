import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ShardConfig } from '@gemwright/common/config/types';
import type { LogParts } from '@gemwright/deployment/logs';
import { attachedCommand, command, createArchive } from '@gemwright/deployment/process';
import type { RestoreParts } from '@gemwright/deployment/restore';
import { sshCommand, vpsRunner } from '@gemwright/deployment/target';

import { restoreSelection } from './local-ops';
import { shellQuote } from './shell';

type Restored = 'server' | 'ai';
const upload = (service: Restored) => `.restore-${service}.tar.gz`;

// World data belongs to the containers (root-owned), so each upload reaches its service's data
// through a one-off container; the start script swaps the restored files in on its next boot and
// keeps the replaced ones.
export function vpsRestoreScript(root: string, restored: Restored[]) {
  return `set -eu
cd ${shellQuote(root)}
if docker info >/dev/null 2>&1; then docker=docker; else docker='sudo -n docker'; fi
${restored
  .map(
    (service) =>
      `$docker compose -f compose.json run --rm --no-deps -T -v "$(pwd)/${upload(service)}:/upload.tar.gz:ro" --entrypoint sh ${service} -c 'rm -rf /app/data/restore /app/data/restore.next && mkdir -p /app/data/restore.next && tar -xzf /upload.tar.gz -C /app/data/restore.next --exclude="._*" && mv /app/data/restore.next /app/data/restore'
rm -f ${upload(service)}`
  )
  .join('\n')}
$docker compose -f compose.json restart ${restored.join(' ')}`;
}

export async function vpsRestore(
  parts: RestoreParts,
  config: ShardConfig,
  confirm: () => Promise<boolean>,
  directory = process.cwd(),
  progress = console.log
) {
  const { source, saves, database, retired, want } = await restoreSelection(parts, directory);
  const restored = (['server', 'ai'] as const).filter((part) => want[part]);
  progress(`Restoring from ${source}:`);
  if (want.server)
    progress(
      '- world saves: the VPS shard restarts and the world returns to this save (current: Saves.before-restore).'
    );
  if (want.ai)
    progress(
      '- resident database: AI residents restart with these residents (current: residents.sqlite.before-restore).'
    );
  if (!parts.yes && !(await confirm())) {
    progress('Nothing was restored.');
    return;
  }
  const vps = vpsRunner(directory, config);
  const staging = await mkdtemp(join(tmpdir(), 'gemwright-restore-'));
  try {
    const { ssh, port } = config.vps ?? {};
    for (const service of restored) {
      const archive = join(staging, upload(service));
      if (service === 'server') await createArchive(archive, dirname(saves), ['Saves'], directory);
      else
        await createArchive(
          archive,
          dirname(database),
          ['residents.sqlite', ...(existsSync(retired) ? ['retired.json'] : [])],
          directory
        );
      await attachedCommand(
        ssh
          ? [...sshCommand(undefined, port, [], 'scp'), archive, `${ssh}:${vps.root}/${upload(service)}`]
          : ['cp', archive, join(vps.root, upload(service))],
        directory
      );
    }
    progress(`Restarting ${restored.join(' and ')}...`);
    await attachedCommand(vps.shell(vpsRestoreScript(vps.root, restored)), directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  progress('Restored. Each service swaps the restored files in as it starts.');
}

const services = { server: ['server'], client: ['client', 'caddy'], ai: ['ai'] } as const;

// Runs Docker Compose in the VPS deployment folder for the selected parts that are deployed there.
export async function vpsCompose(
  config: ShardConfig,
  parts: LogParts,
  args: (services: string[]) => string[],
  directory = process.cwd()
) {
  const vps = vpsRunner(directory, config);
  const state = JSON.parse(await command(vps.shell(`cat ${shellQuote(`${vps.root}/state.json`)}`), directory));
  const deployed = (['server', 'client', 'ai'] as const).filter((part) => part === 'server' || state[part]);
  const all = !parts.server && !parts.client && !parts.ai;
  const selected = deployed.filter((part) => all || parts[part]);
  if (!selected.length) throw new Error('None of the selected services is deployed here.');
  await attachedCommand(
    vps.shell(`set -eu
cd ${shellQuote(vps.root)}
if docker info >/dev/null 2>&1; then docker=docker; else docker='sudo -n docker'; fi
$docker compose -f compose.json ${args(selected.flatMap((part) => services[part]))
      .map(shellQuote)
      .join(' ')}`),
    directory
  );
}
