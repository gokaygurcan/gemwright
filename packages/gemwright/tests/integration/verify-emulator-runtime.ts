import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Huffman } from '@gemwright/common/huffman';

import { createConfig } from '../../src/config';
import { fetchDotnetFiles, prepareDotnetFiles } from '../../src/emulators/dotnet/init';
import { resolveDotnetSource } from '../../src/emulators/dotnet/source';
import { stageDotnet } from '../../src/emulators/dotnet/staging';
import { fetchSphereFiles, prepareSphereFiles } from '../../src/emulators/sphere/config';
import { resolveLatestSphereSources } from '../../src/emulators/sphere/source';
import { stageSphere } from '../../src/emulators/sphere/staging';
import { saveInstance } from '../../src/instance';
import { command } from '../../src/process';

const emulator = process.argv[2];
if (emulator !== 'runuo' && emulator !== 'modernuo' && emulator !== 'sphere-x')
  throw new Error('Usage: bun tests/integration/verify-emulator-runtime.ts <runuo|modernuo|sphere-x> <client-files>');
const clientFiles = resolve(process.argv[3] ?? 'files');
const root = await mkdtemp(join(tmpdir(), 'gemwright-runtime-'));
const name = `gemwright-${emulator}-${randomUUID().slice(0, 8)}`;
const image = process.env.GEMWRIGHT_TEST_IMAGE ?? `${name}:local`;
const docker = (args: string[]) => command(['docker', ...args], root);
const password = 'test-password';
const listener = net.createServer();
await new Promise<void>((accept) => listener.listen(0, '127.0.0.1', accept));
const address = listener.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((accept) => listener.close(() => accept()));
const field = (value: string) => {
  const result = Buffer.alloc(30);
  result.write(value, 'ascii');
  return result;
};

async function connect(compressed = false) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const decoder = new Huffman();
  const connection = { socket, buffer: Buffer.alloc(0), closed: false };
  socket.on(
    'data',
    (data: Buffer) =>
      (connection.buffer = Buffer.concat([connection.buffer, compressed ? decoder.decompress(data) : data]))
  );
  socket.on('close', () => (connection.closed = true));
  socket.on('error', () => {});
  await new Promise<void>((accept, reject) => {
    socket.once('connect', accept);
    socket.once('error', reject);
  });
  return connection;
}
async function until(
  connection: Awaited<ReturnType<typeof connect>>,
  predicate: (buffer: Buffer) => boolean,
  allowClosed = false
) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate(connection.buffer)) return connection.buffer;
    if (connection.closed) {
      if (allowClosed) return connection.buffer;
      throw new Error(`Connection closed: ${connection.buffer.toString('hex')}`);
    }
    await Bun.sleep(25);
  }
  throw new Error(`Protocol timed out: ${connection.buffer.subarray(0, 80).toString('hex')}`);
}
async function login(wrong = false) {
  const connection = await connect();
  try {
    const seed = Buffer.alloc(21);
    seed[0] = 0xef;
    [0x12345678, 7, 0, 114, 40].forEach((value, index) => {
      seed.writeUInt32BE(value, 1 + index * 4);
    });
    connection.socket.write(
      Buffer.concat([
        seed,
        Buffer.from([0x80]),
        field('admin'),
        field(wrong ? 'wrong-password' : password),
        Buffer.from([0])
      ])
    );
    if (wrong) {
      const result = await until(connection, (buffer) => buffer.length >= 2, true);
      assert.ok(connection.closed || result[0] === 0x82, 'Wrong password must be rejected');
      return 0;
    }
    const list = await until(connection, (buffer) => buffer.length >= 3 && buffer.length >= buffer.readUInt16BE(1));
    assert.equal(list[0], 0xa8);
    const selection = Buffer.from([0xa0, 0, 0]);
    selection.writeUInt16BE(list.readUInt16BE(6), 1);
    connection.buffer = Buffer.alloc(0);
    connection.socket.write(selection);
    const relay = await until(connection, (buffer) => buffer.length >= 11);
    assert.equal(relay[0], 0x8c);
    assert.deepEqual([...relay.subarray(1, 5)], [127, 0, 0, 1]);
    assert.equal(relay.readUInt16BE(5), port);
    return relay.readUInt32BE(7);
  } finally {
    connection.socket.destroy();
  }
}
async function characterList(auth: number) {
  const connection = await connect(true);
  try {
    const token = Buffer.alloc(4);
    token.writeUInt32BE(auth);
    connection.socket.write(Buffer.concat([token, Buffer.from([0x91]), token, field('admin'), field(password)]));
    await until(connection, (buffer) => {
      const index = buffer.indexOf(0xa9);
      return index >= 0 && buffer.length >= index + 4 && buffer.length >= index + buffer.readUInt16BE(index + 1);
    });
  } finally {
    connection.socket.destroy();
  }
}
async function ready(previousStarts = 0) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const [state] = JSON.parse(await docker(['inspect', name]));
    if (!state.State.Running) throw new Error(await docker(['logs', name]));
    const logs = await docker(['logs', name]);
    if ((logs.match(/Listening: 127\.0\.0\.1:2593|Startup complete/g) ?? []).length > previousStarts) return;
    await Bun.sleep(500);
  }
  throw new Error('Server did not become ready.');
}
async function manifest(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory())
      files.push(...(await manifest(join(path, entry.name))).map((name) => `${entry.name}/${name}`));
    else files.push(`${entry.name}:${Buffer.from(await readFile(join(path, entry.name))).toString('base64')}`);
  }
  return files.sort();
}
try {
  if (!process.env.GEMWRIGHT_TEST_IMAGE) {
    const directory = join(root, 'shard');
    const settings = { owner: 'admin', autoCreateAccounts: false };
    if (emulator === 'sphere-x') {
      const pair = await resolveLatestSphereSources(undefined, emulator);
      const sphere = {
        ...settings,
        scriptsSource: pair.scripts,
        maps: 'expansion' as const,
        mapSize: 'modern' as const,
        clientEncryption: 'both' as const
      };
      const config = createConfig({ emulator, timezone: 'Europe/London', source: pair.server, sphere });
      await saveInstance(
        directory,
        config,
        false,
        prepareSphereFiles(await fetchSphereFiles(pair), config, sphere, password)
      );
      await stageSphere(directory, config);
    } else {
      const config = createConfig({ emulator, source: await resolveDotnetSource(emulator), [emulator]: settings });
      await saveInstance(
        directory,
        config,
        false,
        prepareDotnetFiles(await fetchDotnetFiles(config), config, settings, password)
      );
      await stageDotnet(directory, config);
    }
    await docker(['build', '-t', image, join(directory, '.gemwright/deploy')]);
  }
  await docker(['volume', 'create', name]);
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'RAILWAY_TCP_PROXY_DOMAIN=127.0.0.1',
    '-e',
    `RAILWAY_TCP_PROXY_PORT=${port}`,
    '-p',
    `127.0.0.1:${port}:2593`,
    '--mount',
    `type=volume,source=${name},target=/app/data`,
    '--mount',
    `type=bind,source=${clientFiles},target=/app/data/client,readonly`,
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    'touch /app/data/.client-ready; exec /opt/gemwright/start.sh'
  ]);
  await ready();
  await login(true);
  await Bun.sleep(1500);
  await characterList(await login());
  await docker(['stop', '-t', '30', name]);
  const [stopped] = JSON.parse(await docker(['inspect', name]));
  assert.equal(stopped.State.ExitCode, 0, 'Shutdown must save and exit successfully');
  const saves = emulator === 'sphere-x' ? 'save' : 'Saves';
  await mkdir(join(root, 'before'));
  await docker(['cp', `${name}:/app/data/server/${saves}/.`, join(root, 'before')]);
  const before = await manifest(join(root, 'before'));
  assert.ok(
    before.some((name) => !name.startsWith('.gitkeep')),
    'Shutdown must write world data'
  );
  await docker(['start', name]);
  await ready(1);
  await characterList(await login());
  await mkdir(join(root, 'after'));
  await docker(['cp', `${name}:/app/data/server/${saves}/.`, join(root, 'after')]);
  assert.deepEqual(await manifest(join(root, 'after')), before, 'Restart must preserve saves without reseeding');
  console.log(
    `${emulator}: startup, password rejection, public relay, character list, shutdown save and reload passed.`
  );
} catch (error) {
  console.error(await docker(['logs', name]).catch(() => 'No container logs'));
  throw error;
} finally {
  await docker(['rm', '-f', name]).catch(() => {});
  await docker(['volume', 'rm', name]).catch(() => {});
  if (!process.env.GEMWRIGHT_TEST_IMAGE) await docker(['image', 'rm', image]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
