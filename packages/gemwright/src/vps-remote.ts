import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import * as prompts from '@clack/prompts';

import { loadShard } from './config';
import { type DeployOptions, validateRemotePath, validateSshDestination } from './deploy-options';
import { attachedCommand, command } from './process';
import { answer } from './prompts';
import { deployVps } from './vps-deploy';
import { nativePackages, shellQuote } from './vps-native';

export function inspectVpsDestination(destination: string, remote: (script: string) => Promise<string>) {
  return remote(`set -eu
if [ -f ${shellQuote(`${destination}/state.json`)} ]; then cat ${shellQuote(`${destination}/state.json`)};
elif [ -f ${shellQuote(`${destination}/.provisioning.json`)} ]; then cat ${shellQuote(`${destination}/.provisioning.json`)};
elif [ -d ${shellQuote(destination)} ] && [ -n "$(ls -A ${shellQuote(destination)})" ]; then
    echo 'Destination is not an empty Gemwright deployment directory.' >&2; exit 1
fi`);
}

export async function createVpsUpload(
  root: string,
  directory: string,
  names: string[],
  incomingName: string,
  clientDigest?: string
) {
  const archive = join(root, `${incomingName}.tar.gz`);
  const seed = join(root, 'client-import');
  try {
    if (clientDigest) {
      await mkdir(seed, { recursive: true });
      await copyFile(join(directory, '.gemwright', `client-${clientDigest}.tar.gz`), join(seed, 'client.tar.gz'));
    }
    await command(
      ['tar', '--no-xattrs', '-czf', archive, '-C', root, ...names, ...(clientDigest ? ['client-import'] : [])],
      directory
    );
    await chmod(archive, 0o600);
    return archive;
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
}

export async function deployVpsRemote(options: DeployOptions, directory = process.cwd()) {
  const host = options.ssh;
  const destination = options.remotePath;
  if (!host || !destination) throw new Error('Remote deployment requires an SSH destination and deployment directory.');
  validateSshDestination(host);
  validateRemotePath(destination);
  if (options.prepare) throw new Error('--prepare generates a local bundle; omit --ssh to use it.');
  const remote = (script: string) => command(['ssh', host, script], directory);
  const config = await loadShard(directory);
  const packages =
    options.method === 'native' ? nativePackages(config, options.client) : ['docker.io', 'docker-compose-v2'];
  const inspection = await remote(`set -eu
. /etc/os-release
echo "$ID"
for package in ${packages.map(shellQuote).join(' ')}; do
    if [ "$package" = dotnet-sdk-10.0 ] && command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks | grep -q '^10\\.'; then continue; fi
    if [ "$(dpkg-query -W -f='\${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then echo "$package"; fi
done`);
  const [os, ...missing] = inspection.split('\n');
  if (options.method === 'native' && os !== 'ubuntu')
    throw new Error('Native VPS installation currently supports Ubuntu with systemd.');
  // Existing Docker installations may come from Docker's own repository instead of Ubuntu packages.
  const dockerReady =
    options.method !== 'native' &&
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
  const root = await deployVps({ ...options, prepare: true }, directory);
  const localState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  const existing = await inspectVpsDestination(destination, remote);
  if (existing) {
    const previous = JSON.parse(existing);
    if (
      previous.emulator !== localState.emulator ||
      previous.clientDigest !== localState.clientDigest ||
      (previous.method ?? 'docker') !== localState.method
    )
      throw new Error('The remote deployment uses another emulator, method or client files. It was not replaced.');
    if (previous.client && !localState.client)
      throw new Error('The remote deployment includes a web client; repeat --client and --domain.');
  }
  const incomingName = `.incoming-${randomUUID()}`;
  const incoming = `${destination}/${incomingName}`;
  await remote(`set -eu
umask 077
mkdir -p ${shellQuote(destination)}
printf '%s\\n' ${shellQuote(JSON.stringify(localState))} > ${shellQuote(`${destination}/.provisioning.json`)}
mkdir -p ${shellQuote(incoming)}
chmod 700 ${shellQuote(destination)} ${shellQuote(incoming)}`);
  const names = ['shard', 'state.json'];
  const needData = await remote(
    `if [ -f ${shellQuote(`${destination}/data/.client-ready`)} ] || [ -f ${shellQuote(`${destination}/data/client.tar.gz`)} ]; then echo no; else echo yes; fi`
  );
  if (options.client) names.push('web', 'gamefiles', 'Caddyfile');
  if (options.method === 'native')
    names.push('native.env', 'install-native.sh', 'start-native.sh', 'start-web.sh', 'start-caddy.sh', 'run-server.sh');
  else names.push('compose.json');
  if (await stat(join(root, '.env')).catch(() => undefined)) names.push('.env');
  console.log(`Uploading the VPS bundle to ${host}:${destination}...`);
  const archive = await createVpsUpload(
    root,
    directory,
    names,
    incomingName,
    needData === 'yes' ? localState.clientDigest : undefined
  );
  try {
    await attachedCommand(['scp', archive, `${host}:${incoming}/bundle.tar.gz`], directory);
    await remote(
      `tar -xzf ${shellQuote(`${incoming}/bundle.tar.gz`)} -C ${shellQuote(incoming)} && rm ${shellQuote(`${incoming}/bundle.tar.gz`)}`
    );
  } catch (error) {
    await remote(`rm -rf -- ${shellQuote(incoming)}`).catch(() => {});
    throw error;
  } finally {
    await rm(archive, { force: true });
  }
  const bootstrap =
    options.method === 'native'
      ? ''
      : install && !dockerReady
        ? '$root_cmd apt-get update\n$root_cmd apt-get install -y docker.io docker-compose-v2\n$root_cmd systemctl enable --now docker'
        : '';
  const start =
    options.method === 'native'
      ? `$root_cmd sh install-native.sh${install ? ' --install-deps' : ''}`
      : `if docker info >/dev/null 2>&1; then docker_cmd=docker; else docker_cmd='sudo docker'; fi
$docker_cmd compose -f compose.json config --quiet
for container in $($docker_cmd ps -aq --filter ${shellQuote(`label=com.docker.compose.project=gemwright-${config.id}`)}); do
    owner=$($docker_cmd inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")
    if [ "$owner" != "$(pwd)" ]; then echo 'This Compose project belongs to another deployment directory.' >&2; exit 1; fi
done
$docker_cmd compose -f compose.json up -d --build --wait --wait-timeout 180`;
  const script = `set -eu
if [ "$(id -u)" = 0 ]; then root_cmd=''; else root_cmd=sudo; fi
${bootstrap}
cd ${shellQuote(destination)}
incoming=${shellQuote(incomingName)}
for name in shard web gamefiles; do
    if [ -d "$incoming/$name" ]; then rm -rf "$name"; mv "$incoming/$name" "$name"; fi
done
mkdir -p data
if [ ! -e data/.client-ready ] && [ ! -e data/client.tar.gz ] && [ -f "$incoming/client-import/client.tar.gz" ]; then
    mv "$incoming/client-import/client.tar.gz" data/client.tar.gz
fi
if [ -f "$incoming/.env" ] && [ ! -e .env ]; then cp "$incoming/.env" .env; chmod 600 .env; fi
for name in compose.json Caddyfile state.json native.env install-native.sh start-native.sh start-web.sh start-caddy.sh run-server.sh; do
    if [ -f "$incoming/$name" ]; then mv "$incoming/$name" "$name"; fi
done
rm -rf "$incoming"
${start}`;
  await attachedCommand(['ssh', ...(process.stdin.isTTY ? ['-t'] : []), host, script], directory);
  await remote(`rm -f -- ${shellQuote(`${destination}/.provisioning.json`)}`);
  console.log(`VPS deployed. Native client: ${options.publicHost}:2593`);
  if (options.client) console.log(`ClassicUO: https://${options.domain}`);
  return root;
}
