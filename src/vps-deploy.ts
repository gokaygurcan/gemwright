import { randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import { assetPath } from './assets';
import { createManifest } from './client-files';
import { loadShard, type ShardConfig } from './config';
import { deployments } from './deploy';
import { attachedCommand, command } from './process';
import { writeNativeBundle } from './vps-native';
import { localPrerequisites } from './vps-prerequisites';

export interface VpsOptions {
  files?: string;
  client?: boolean;
  publicHost?: string;
  domain?: string;
  prepare?: boolean;
  method?: string;
  installDeps?: boolean;
}

export function validateVpsOptions(options: VpsOptions) {
  if (options.method && !['docker', 'native'].includes(options.method))
    throw new Error('--method must be docker or native.');
  const hostname = (value: string) =>
    value.length <= 253 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (
    !options.publicHost ||
    (!hostname(options.publicHost) && isIP(options.publicHost) !== 4) ||
    isIP(options.publicHost) === 6
  )
    throw new Error('--public-host requires the VPS public IPv4 address or a hostname resolving to IPv4.');
  if (
    options.client &&
    (!options.domain || !hostname(options.domain) || !options.domain.includes('.') || isIP(options.domain))
  )
    throw new Error('--client requires --domain with a public DNS hostname for HTTPS.');
  if (options.domain && !options.client) throw new Error('--domain requires --client.');
}

interface VpsState {
  emulator: string;
  clientDigest: string;
  client: boolean;
  method?: string;
}

const exists = async (path: string) =>
  !!(await stat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }));

// State stays outside the replaceable build contexts so rebuilds cannot erase a live world.
export async function writeVpsBundle(
  directory: string,
  config: ShardConfig,
  options: VpsOptions,
  staged: string,
  client: { archive: string; digest: string },
  assets?: string
) {
  validateVpsOptions(options);
  const root = join(directory, options.method === 'native' ? '.gemwright/vps-native' : '.gemwright/vps');
  const statePath = join(root, 'state.json');
  const previous: VpsState | undefined = await readFile(statePath, 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (previous && previous.emulator !== config.emulator)
    throw new Error('The VPS bundle belongs to another emulator. Use a separate shard directory.');
  if (previous && (previous.method ?? 'docker') !== (options.method ?? 'docker'))
    throw new Error('This bundle uses a different deployment method. Use a separate deployment directory.');
  if (previous && previous.clientDigest !== client.digest)
    throw new Error('Different client files are already recorded in this VPS bundle. They were not replaced.');
  if (previous?.client && !options.client)
    throw new Error('This VPS bundle includes a web client. Repeat --client and --domain to keep it deployed.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'data'), { recursive: true });
  if (!previous) {
    const markers = [
      '.initialized',
      '.sphere-initialized',
      '.sphere-x-initialized',
      '.runuo-initialized',
      '.modernuo-initialized',
      '.client-ready'
    ];
    for (const marker of markers)
      if (await exists(join(root, 'data', marker)))
        throw new Error('Existing VPS data found without deployment state; refusing to import client files.');
    await copyFile(client.archive, join(root, 'data/client.tar.gz.tmp'));
    await rename(join(root, 'data/client.tar.gz.tmp'), join(root, 'data/client.tar.gz'));
  }
  await rm(join(root, 'shard.next'), { recursive: true, force: true });
  await cp(staged, join(root, 'shard.next'), { recursive: true });
  await rm(join(root, 'shard'), { recursive: true, force: true });
  await rename(join(root, 'shard.next'), join(root, 'shard'));
  const environment: Record<string, string> = { TZ: config.timezone, GEMWRIGHT_PUBLIC_HOST: options.publicHost ?? '' };
  const shard: Record<string, unknown> = {
    build: './shard',
    restart: 'unless-stopped',
    stop_grace_period: '2m',
    ports: ['2593:2593/tcp'],
    environment,
    volumes: ['./data:/app/data'],
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }
  };
  const services: Record<string, unknown> = { shard };
  const volumes: Record<string, unknown> = {};
  if (config.sphere?.mysql) {
    const secrets = join(root, '.env');
    if (!(await exists(secrets)))
      await writeFile(
        secrets,
        `MYSQL_PASSWORD=${randomBytes(32).toString('hex')}\nMYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}\n`,
        { mode: 0o600, flag: 'wx' }
      );
    Object.assign(environment, {
      MYSQLHOST: 'mysql',
      MYSQLPORT: '3306',
      MYSQLUSER: 'gemwright',
      MYSQLPASSWORD: '$' + '{MYSQL_PASSWORD:?Missing MYSQL_PASSWORD}',
      MYSQLDATABASE: 'gemwright'
    });
    shard.depends_on = { mysql: { condition: 'service_healthy' } };
    services.mysql = {
      image: 'mysql:8.4',
      restart: 'unless-stopped',
      stop_grace_period: '1m',
      environment: {
        MYSQL_DATABASE: 'gemwright',
        MYSQL_USER: 'gemwright',
        MYSQL_PASSWORD: '$' + '{MYSQL_PASSWORD:?Missing MYSQL_PASSWORD}',
        MYSQL_ROOT_PASSWORD: '$' + '{MYSQL_ROOT_PASSWORD:?Missing MYSQL_ROOT_PASSWORD}'
      },
      volumes: ['mysql-data:/var/lib/mysql'],
      healthcheck: {
        test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 --silent'],
        interval: '5s',
        timeout: '5s',
        retries: 30
      }
    };
    volumes['mysql-data'] = {};
  }
  if (options.client) {
    if (!assets) throw new Error('Web client assets are required.');
    const files = await createManifest(assets);
    const gamefiles = join(root, 'gamefiles');
    await mkdir(gamefiles, { recursive: true, mode: 0o755 });
    await chmod(gamefiles, 0o755);
    // Copy only manifested files; executables and account files never enter the public directory.
    if (!previous?.client) {
      for (const file of files) {
        const target = join(gamefiles, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await copyFile(join(assets, file.path), target);
        await chmod(target, 0o644);
        let parent = dirname(target);
        while (parent !== root) {
          await chmod(parent, 0o755);
          if (parent === gamefiles) break;
          parent = dirname(parent);
        }
      }
    } else {
      const installed = JSON.parse(await readFile(join(gamefiles, 'manifest.json'), 'utf8'));
      if (JSON.stringify(installed.files) !== JSON.stringify(files))
        throw new Error('The web client has different game files. They were not replaced.');
    }
    await writeFile(join(gamefiles, 'manifest.json'), `${JSON.stringify({ files })}\n`, { mode: 0o644 });
    await chmod(join(gamefiles, 'manifest.json'), 0o644);
    await rm(join(root, 'web'), { recursive: true, force: true });
    await mkdir(join(root, 'web'));
    for (const name of [
      'Dockerfile',
      '.dockerignore',
      'build.ts',
      'files.ts',
      'huffman.ts',
      'server.ts',
      'web',
      'runtime'
    ])
      await cp(assetPath(`client/${name}`), join(root, 'web', name), { recursive: true });
    services.web = {
      build: './web',
      restart: 'unless-stopped',
      depends_on: ['shard'],
      environment: {
        UO_HOST: 'shard',
        UO_PORT: '2593',
        PUBLIC_ORIGIN: `https://${options.domain}`,
        SERVER_NAME: config.name.replaceAll('$', () => '$$'),
        UO_CLIENT_VERSION: process.env.UO_CLIENT_VERSION ?? '7.0.45.1',
        UO_ENCRYPTION: process.env.UO_ENCRYPTION ?? '0'
      },
      volumes: ['./gamefiles:/app/data/gamefiles:ro'],
      healthcheck: {
        test: [
          'CMD',
          'bun',
          '-e',
          "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        interval: '10s',
        timeout: '5s',
        retries: 12
      }
    };
    services.caddy = {
      image: 'caddy:2.11-alpine',
      restart: 'unless-stopped',
      depends_on: { web: { condition: 'service_healthy' } },
      ports: ['80:80/tcp', '443:443/tcp', '443:443/udp'],
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config']
    };
    volumes['caddy-data'] = {};
    volumes['caddy-config'] = {};
    await writeFile(join(root, 'Caddyfile'), `${options.domain} {\n    reverse_proxy web:3000\n}\n`);
  }
  const compose = { name: `gemwright-${config.id}`, services, ...(Object.keys(volumes).length ? { volumes } : {}) };
  if (options.method === 'native') await writeNativeBundle(root, config, options);
  else await writeFile(join(root, 'compose.json'), `${JSON.stringify(compose, null, 2)}\n`);
  await writeFile(
    `${statePath}.tmp`,
    `${JSON.stringify({ emulator: config.emulator, clientDigest: client.digest, client: !!options.client, method: options.method ?? 'docker' }, null, 2)}\n`
  );
  await rename(`${statePath}.tmp`, statePath);
  return root;
}

export async function deployVps(options: VpsOptions, directory = process.cwd()) {
  validateVpsOptions(options);
  directory = resolve(directory);
  if (!options.prepare && process.platform !== 'linux')
    throw new Error('VPS deployment runs on Linux. Use --ssh to deploy remotely or --prepare to generate a bundle.');
  const config = await loadShard(directory);
  const source =
    options.files ?? (config.emulator === 'sphere-x' ? config.sphere : config[config.emulator])?.clientFiles;
  if (!source) throw new Error('VPS deployment requires --files <path> or clientFiles in gemwright.json.');
  const emulator = deployments[config.emulator];
  await emulator.validate(directory, config);
  console.log(`Staging ${emulator.label} for VPS deployment...`);
  const staged = await emulator.stage(directory, config);
  const assets = resolve(directory, source);
  const client = await emulator.packageFiles(directory, assets);
  const root = await writeVpsBundle(directory, config, options, staged, client, assets);
  console.log(`VPS bundle: ${root}`);
  if (options.prepare) {
    if (options.method === 'native')
      console.log('Copy this entire directory to the VPS, then run: sudo sh install-native.sh');
    else
      console.log(
        'Copy this entire directory (including hidden files) to the VPS, then run: docker compose -f compose.json up -d --build --wait --wait-timeout 180'
      );
    return root;
  }
  const prerequisites = await localPrerequisites(options, config, root);
  if (options.method === 'native') {
    await attachedCommand(
      [
        ...(process.getuid?.() === 0 ? [] : ['sudo']),
        'sh',
        'install-native.sh',
        ...(prerequisites.install ? ['--install-deps'] : [])
      ],
      root
    );
    return root;
  }
  await attachedCommand([...prerequisites.sudo, 'docker', 'compose', '-f', 'compose.json', 'config', '--quiet'], root);
  const containers = await command(
    [
      ...prerequisites.sudo,
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=gemwright-${config.id}`
    ],
    root
  );
  if (containers) {
    const states = JSON.parse(
      await command([...prerequisites.sudo, 'docker', 'inspect', ...containers.split(/\s+/)], root)
    );
    if (
      states.some(
        (state: { Config: { Labels: Record<string, string> } }) =>
          state.Config.Labels['com.docker.compose.project.working_dir'] !== root
      )
    )
      throw new Error('This Compose project belongs to another deployment directory.');
  }
  await attachedCommand(
    [
      ...prerequisites.sudo,
      'docker',
      'compose',
      '-f',
      'compose.json',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '180'
    ],
    root
  );
  console.log(`VPS containers started. Native client: ${options.publicHost}:2593`);
  if (options.client) console.log(`ClassicUO: https://${options.domain} (DNS must point to this VPS).`);
  return root;
}
