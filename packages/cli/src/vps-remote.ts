import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { GameFile } from '@gemwright/client/files';
import { attachedCommand, command, createArchive } from '@gemwright/deployment/process';
import { sshCommand } from '@gemwright/deployment/target';
import { loadShard, type ShardConfig } from '@gemwright/server/config';

import * as prompts from '@clack/prompts';

import { type DeployOptions, validateRemotePath, validateSshDestination } from './deploy-options';
import { answer } from './prompts';
import { shellQuote } from './shell';
import { builtImages, builtServices, composeServices, deployVps, dockerPlatform } from './vps-deploy';
import { preflight, reachable } from './vps-preflight';

export function inspectVpsDestination(destination: string, remote: (script: string) => Promise<string>) {
  return remote(`set -eu
if [ -f ${shellQuote(`${destination}/state.json`)} ]; then cat ${shellQuote(`${destination}/state.json`)};
elif [ -f ${shellQuote(`${destination}/.provisioning.json`)} ]; then cat ${shellQuote(`${destination}/.provisioning.json`)};
elif [ -d ${shellQuote(destination)} ] && [ -n "$(ls -A ${shellQuote(destination)})" ]; then
    echo 'Destination is not an empty Gemwright deployment directory.' >&2; exit 1
fi`);
}

// macOS tar can store extended attributes as AppleDouble ._ files, which builds then read as source.
export const extractUpload = (archive: string, directory: string) =>
  `tar -xzf ${shellQuote(archive)} -C ${shellQuote(directory)} --exclude='._*' && rm ${shellQuote(archive)}`;

// Which game files the VPS lacks or holds in another version, judged by its own manifest, and
// which it holds that left the selection. The manifest itself always travels.
export async function gameFilesChanges(root: string, remoteManifest: string) {
  const local: GameFile[] | undefined = await readFile(join(root, 'gamefiles/manifest.json'), 'utf8').then(
    (text) => JSON.parse(text).files,
    () => undefined
  );
  if (!local) return { send: [], stale: [] };
  const remote: GameFile[] = remoteManifest.trim() ? JSON.parse(remoteManifest).files : [];
  const known = new Map(remote.map((file) => [file.path, file.sha256]));
  const wanted = new Set(local.map((file) => file.path));
  return {
    send: [
      'gamefiles/manifest.json',
      ...local.filter((file) => known.get(file.path) !== file.sha256).map((file) => `gamefiles/${file.path}`)
    ],
    stale: remote.filter((file) => !wanted.has(file.path)).map((file) => file.path)
  };
}

export async function createVpsUpload(root: string, directory: string, names: string[], incomingName: string) {
  const archive = join(root, `${incomingName}.tar.gz`);
  try {
    await createArchive(archive, root, names, directory);
    await chmod(archive, 0o600);
    return archive;
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  }
}

// Builds the deployment's images here for the VPS's architecture and loads them there, so the VPS
// spends no memory compiling while its shard and residents run.
async function shipImages(
  root: string,
  config: ShardConfig,
  services: string[],
  host: string,
  port: number | undefined,
  remote: (script: string) => Promise<string>,
  directory: string
) {
  const images = builtImages(config, services);
  if (!images.length) return;
  if (!(await command(['docker', 'info'], directory).then(Boolean, () => false)))
    throw new Error('Docker deployments build their images on this machine: start Docker here and rerun.');
  const platform = dockerPlatform(await remote('uname -m'));
  console.log(`Building ${builtServices(services).join(', ')} for ${platform}...`);
  await attachedCommand(
    [
      'env',
      `DOCKER_DEFAULT_PLATFORM=${platform}`,
      'docker',
      'compose',
      '-f',
      'compose.json',
      'build',
      ...builtServices(services)
    ],
    root
  );
  console.log(`Sending the images to ${host}...`);
  const load = shellQuote('if docker info >/dev/null 2>&1; then docker load; else sudo -n docker load; fi');
  await attachedCommand(
    [
      'sh',
      '-c',
      `docker save ${images.map(shellQuote).join(' ')} | gzip | ${[...sshCommand(host, port), load].join(' ')}`
    ],
    directory
  );
}

export async function deployVpsRemote(options: DeployOptions, directory = process.cwd()) {
  const host = options.ssh;
  const destination = options.remotePath;
  if (!host || !destination) throw new Error('Remote deployment requires an SSH destination and deployment directory.');
  validateSshDestination(host);
  validateRemotePath(destination);
  if (options.prepare) throw new Error('--prepare generates a local bundle; omit --ssh to use it.');
  const remote = (script: string) => command([...sshCommand(host, options.sshPort), script], directory);
  const config = await loadShard(directory);
  const packages = ['docker.io', 'docker-compose-v2'];
  const inspection = await remote(`set -eu
. /etc/os-release
echo "$ID"
for package in ${packages.map(shellQuote).join(' ')}; do
    if [ "$(dpkg-query -W -f='\${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then echo "$package"; fi
done`);
  const [os, ...missing] = inspection.split('\n');
  // Existing Docker installations may come from Docker's own repository instead of Ubuntu packages.
  const dockerReady =
    (await remote('if docker compose version >/dev/null 2>&1; then echo yes; else echo no; fi')) === 'yes';
  let install = options.installDeps ?? false;
  if (missing.length && !dockerReady && !install && process.stdin.isTTY && !options.yes) {
    install = answer(
      await prompts.confirm({
        message: `Install missing packages on ${host}: ${missing.join(', ')}? This requires sudo.`,
        initialValue: false
      })
    );
  }
  if (missing.length && !dockerReady && !install)
    throw new Error(
      `Missing VPS packages: ${missing.join(', ')}. Run interactively to approve installation, or pass --install-deps. Nothing was installed.`
    );
  if (install && os !== 'ubuntu') throw new Error('Automatic package installation currently supports Ubuntu.');
  const existing = await inspectVpsDestination(destination, remote);
  await preflight({ ...options, installDeps: install }, destination, !!existing, remote);
  const root = await deployVps({ ...options, prepare: true }, directory);
  const localState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  if (existing) {
    const previous = JSON.parse(existing);
    if (previous.emulator !== localState.emulator)
      throw new Error('The remote deployment uses another emulator. It was not replaced.');
  }
  const incomingName = `.incoming-${randomUUID()}`;
  const incoming = `${destination}/${incomingName}`;
  await remote(`set -eu
umask 077
mkdir -p ${shellQuote(destination)}
printf '%s\\n' ${shellQuote(JSON.stringify(localState))} > ${shellQuote(`${destination}/.provisioning.json`)}
mkdir -p ${shellQuote(incoming)}
chmod 700 ${shellQuote(destination)} ${shellQuote(incoming)}`);
  const server = options.server !== false;
  if (!server && !existing) throw new Error('Deploy the server to this VPS first: gemwright shard deploy --server.');
  // The images arrive built, so their sources stay here.
  const names = ['state.json', 'compose.json'];
  if (options.client) names.push('Caddyfile');
  if (options.ai) names.push('world', 'ai.env');
  const sync = await gameFilesChanges(
    root,
    await remote(`cat ${shellQuote(`${destination}/gamefiles/manifest.json`)} 2>/dev/null || true`)
  );
  names.push(...sync.send);
  if (await stat(join(root, '.env')).catch(() => undefined)) names.push('.env');
  await shipImages(root, config, composeServices(options, config), host, options.sshPort, remote, directory);
  console.log(`Uploading the VPS bundle to ${host}:${destination}...`);
  const archive = await createVpsUpload(root, directory, names, incomingName);
  try {
    await attachedCommand(
      [...sshCommand(undefined, options.sshPort, [], 'scp'), archive, `${host}:${incoming}/bundle.tar.gz`],
      directory
    );
    await remote(extractUpload(`${incoming}/bundle.tar.gz`, incoming));
  } catch (error) {
    await remote(`rm -rf -- ${shellQuote(incoming)}`).catch(() => {});
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
  const bootstrap =
    install && !dockerReady
      ? '$root_cmd apt-get update\n$root_cmd apt-get install -y docker.io docker-compose-v2\n$root_cmd systemctl enable --now docker'
      : '';
  const services = composeServices(options, config).join(' ');
  const start = `if docker info >/dev/null 2>&1; then docker_cmd=docker; else docker_cmd='sudo docker'; fi
$docker_cmd compose -f compose.json config --quiet
for container in $($docker_cmd ps -aq --filter ${shellQuote(`label=com.docker.compose.project=gemwright-${config.id}`)}); do
    owner=$($docker_cmd inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")
    if [ "$owner" != "$(pwd)" ]; then echo 'This Compose project belongs to another deployment directory.' >&2; exit 1; fi
done
$docker_cmd compose -f compose.json up -d --no-build --no-deps --remove-orphans --wait --wait-timeout 900 ${services}`;
  const script = `set -eu
if [ "$(id -u)" = 0 ]; then root_cmd=''; else root_cmd=sudo; fi
${bootstrap}
cd ${shellQuote(destination)}
incoming=${shellQuote(incomingName)}
if [ -d "$incoming/world" ]; then rm -rf world; mv "$incoming/world" world; fi
if [ -d "$incoming/gamefiles" ]; then mkdir -p gamefiles; chmod 755 gamefiles; cp -R "$incoming/gamefiles/." gamefiles/; fi
${sync.stale.length ? `rm -f -- ${sync.stale.map((path) => shellQuote(`gamefiles/${path}`)).join(' ')}` : ''}
mkdir -p data
if [ -f "$incoming/.env" ] && [ ! -e .env ]; then cp "$incoming/.env" .env; chmod 600 .env; fi
for name in compose.json Caddyfile ai.env state.json; do
    if [ -f "$incoming/$name" ]; then mv "$incoming/$name" "$name"; fi
done
rm -rf "$incoming"
${start}`;
  await attachedCommand([...sshCommand(host, options.sshPort, process.stdin.isTTY ? ['-t'] : []), script], directory);
  await remote(`rm -f -- ${shellQuote(`${destination}/.provisioning.json`)}`);
  await reachable(options.publicHost ?? '', 2593);
  console.log(`VPS deployed. Native client: ${options.publicHost}:2593`);
  if (options.client) console.log(`ClassicUO: https://${options.domain}`);
  return root;
}
