import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfig } from '../../src/config';
import { fetchSphereFiles, prepareSphereFiles } from '../../src/emulators/sphere/config';
import { resolveLatestSphereSources } from '../../src/emulators/sphere/source';
import { packageClientFiles, stageSphere } from '../../src/emulators/sphere/staging';
import { saveInstance } from '../../src/instance';
import { command } from '../../src/process';
import { required } from '../../src/required';

const root = await mkdtemp(join(tmpdir(), 'gemwright-sphere-runtime-'));
const name = `gemwright-sphere-test-${randomUUID().slice(0, 8)}`;
const image = `${name}:local`;
const helperImage = 'node:24-bookworm-slim';
const subnetBytes = randomBytes(2);
const subnet = `100.${64 + ((subnetBytes[0] ?? 0) % 64)}.${subnetBytes[1]}`;
const docker = (args: string[]) => command(['docker', ...args], root);
const helperExisted = await docker(['image', 'inspect', helperImage]).then(
  () => true,
  () => false
);
const clientPath = resolve(process.argv[2] ?? 'files');
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())));
  return address.port;
}
async function snapshot() {
  const [container] = JSON.parse(await docker(['inspect', name]));
  const logs = await docker(['logs', name]);
  return { container, logs, starts: (logs.match(/Startup complete/g) ?? []).length };
}
async function ready(previousStarts = 0, expectRestart = false) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await snapshot();
    if (state.container.State.Running && state.starts > previousStarts) return state;
    if (state.container.State.Status === 'exited' && !expectRestart)
      throw new Error(`Sphere exited: ${state.logs.slice(-4000)}`);
    await Bun.sleep(500);
  }
  throw new Error('Sphere did not become ready within 60 seconds.');
}
async function protocol(mode: string, peer = '10', parameter = '0') {
  return docker([
    'run',
    '--rm',
    '--network',
    name,
    '--ip',
    `${subnet}.${peer}`,
    '--mount',
    `type=bind,source=${join(root, 'protocol')},target=/tests,readonly`,
    helperImage,
    'node',
    '/tests/protocol.mjs',
    mode,
    'sphere',
    '2593',
    parameter
  ]);
}
async function manifest(directory: string, prefix = '.'): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) entries.push(...(await manifest(path, relative)));
    else
      entries.push(
        `${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}  ${relative}`
      );
  }
  return entries.sort();
}
try {
  console.log('Resolving and staging a disposable Sphere shard...');
  const pair = await resolveLatestSphereSources();
  const settings = {
    scriptsSource: pair.scripts,
    autoCreateAccounts: false,
    owner: 'admin',
    maps: 'expansion' as const,
    mapSize: 'modern' as const,
    clientEncryption: 'both' as const
  };
  const config = createConfig({
    name: 'Sphere Runtime Test',
    timezone: 'Europe/London',
    emulator: 'sphere',
    source: pair.server,
    sphere: settings
  });
  const directory = join(root, 'shard');
  await saveInstance(
    directory,
    config,
    false,
    prepareSphereFiles(await fetchSphereFiles(pair), config, settings, 'Sphere-Password')
  );
  const context = await stageSphere(directory, config);
  await copyFile(
    fileURLToPath(new URL('./sphere/HostingOptionsTests.cpp', import.meta.url)),
    join(context, 'hosting-options-test.cpp')
  );
  const dockerfile = join(context, 'Dockerfile');
  const productionDockerfile = await readFile(dockerfile, 'utf8');
  assert.equal(productionDockerfile.split('\nFROM ubuntu:24.04\n').length, 2);
  await writeFile(
    dockerfile,
    productionDockerfile.replace(
      '\nFROM ubuntu:24.04\n',
      `
COPY hosting-options-test.cpp /tmp/hosting-options-test.cpp
RUN g++ -std=c++20 -I/source/src/graysvr /tmp/hosting-options-test.cpp -o /tmp/hosting-options-test && /tmp/hosting-options-test

FROM ubuntu:24.04
`
    )
  );
  const client = await packageClientFiles(directory, clientPath);
  const protocolDirectory = join(root, 'protocol');
  await mkdir(protocolDirectory);
  await copyFile(
    fileURLToPath(new URL('./sphere/protocol.mjs', import.meta.url)),
    join(protocolDirectory, 'protocol.mjs')
  );
  const compression = await readFile(join(context, 'server/src/common/CEncrypt.cpp'), 'utf8');
  const table = required(
    compression.split('const WORD CHuffman::sm_xCompress_Base')[1]?.split('{')[1]?.split('};')[0],
    'Sphere Huffman table'
  );
  const codes = [...table.matchAll(/0x[\da-f]+/gi)].map(([code]) => Number(code));
  assert.equal(codes.length, 257, 'Upstream protocol compression table changed');
  await writeFile(join(protocolDirectory, 'huffman.json'), JSON.stringify(codes));
  console.log('Building and checking Sphere for Linux x86-64...');
  await docker(['build', '--platform', 'linux/amd64', '-t', image, context]);
  await docker(['volume', 'create', name]);
  await docker(['network', 'create', '--subnet', `${subnet}.0/24`, name]);
  await docker([
    'run',
    '--platform',
    'linux/amd64',
    '--rm',
    '--mount',
    `type=volume,source=${name},target=/app/data`,
    '--mount',
    `type=bind,source=${client.archive},target=/import.tar.gz,readonly`,
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    'cp /import.tar.gz /app/data/client.tar.gz'
  ]);
  const publicPort = await freePort();
  await docker([
    'run',
    '--platform',
    'linux/amd64',
    '-d',
    '--name',
    name,
    '--network',
    name,
    '--network-alias',
    'sphere',
    '--ip',
    `${subnet}.2`,
    '--restart',
    'on-failure:2',
    '--mount',
    `type=volume,source=${name},target=/app/data`,
    '-p',
    `127.0.0.1:${publicPort}:2593`,
    '-e',
    'RAILWAY_TCP_PROXY_DOMAIN=127.0.0.1',
    '-e',
    `RAILWAY_TCP_PROXY_PORT=${publicPort}`,
    '-e',
    `TZ=${config.timezone}`,
    image
  ]);
  await ready();
  const expectedManifest = await manifest(join(context, 'shard'));
  const actualManifest = (
    await docker(['exec', name, 'sh', '-c', 'cd /opt/shard && find . -type f -exec sha256sum {} + | LC_ALL=C sort'])
  ).split('\n');
  assert.deepEqual(actualManifest, expectedManifest, 'Image must preserve shard config and script bytes');
  for (const file of ['sphere.ini', 'sphereCrypt.ini']) {
    const expected = createHash('sha256')
      .update(await readFile(join(directory, file)))
      .digest('hex');
    assert.equal((await docker(['exec', name, 'sha256sum', `/app/data/server/${file}`])).split(' ')[0], expected);
  }
  console.log('Checking proxy connections, passwords and game login...');
  console.log(await protocol('burst'));
  for (let attempt = 0; attempt < 12; attempt++) await protocol('wrong-password');
  const { auth } = JSON.parse(await protocol('login', '10', String(publicPort)));
  console.log(await protocol('game', '11', String(auth)));
  console.log(await protocol('set-state'));
  const beforeStop = await snapshot();
  await docker(['stop', '--timeout', '45', name]);
  const stopped = await snapshot();
  assert.equal(stopped.container.State.ExitCode, 0, stopped.logs.slice(-4000));
  assert.ok(stopped.logs.includes('World save completed'));
  await docker(['start', name]);
  await ready(beforeStop.starts);
  console.log(await protocol('check-state'));
  await protocol('set-state', '10', '67890');
  const beforeCrash = await snapshot();
  await docker(['exec', name, 'sh', '-c', 'set -- $(cat /proc/1/task/1/children); test "$#" -eq 1; kill -KILL "$1"']);
  const recovered = await ready(beforeCrash.starts, true);
  assert.equal(recovered.container.RestartCount, 1);
  console.log(await protocol('check-state'));
  console.log(
    'Sphere startup, exact config/script packaging, public relay, different proxy peers, password checks, save/reload and host crash recovery passed.'
  );
} finally {
  for (const args of [
    ['rm', '-f', name],
    ['volume', 'rm', name],
    ['network', 'rm', name],
    ['image', 'rm', image]
  ])
    await docker(args).catch(() => {});
  if (!helperExisted) await docker(['image', 'rm', helperImage]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
