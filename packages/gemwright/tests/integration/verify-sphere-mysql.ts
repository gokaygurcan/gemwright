import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createConfig } from '../../src/config';
import { fetchSphereFiles, prepareSphereFiles } from '../../src/emulators/sphere/config';
import { resolveLatestSphereSources } from '../../src/emulators/sphere/source';
import { stageSphere } from '../../src/emulators/sphere/staging';
import { saveInstance } from '../../src/instance';
import { command, runCommand } from '../../src/process';
import { required } from '../../src/required';

const emulator = process.argv[2];
if (emulator !== 'sphere' && emulator !== 'sphere-x')
  throw new Error('Usage: bun tests/integration/verify-sphere-mysql.ts <sphere|sphere-x> <client-files>');
const root = await mkdtemp(join(tmpdir(), 'gemwright-mysql-'));
const name = `gemwright-mysql-${randomUUID().slice(0, 8)}`;
const database = `${name}-db`;
const image = process.env.GEMWRIGHT_TEST_IMAGE ?? `${name}:local`;
const clientFiles = resolve(process.argv[3] ?? 'files');
const docker = (args: string[]) => command(['docker', ...args], root);
const dbPassword = randomUUID();
const dbEnv = join(root, 'mysql.env');
const serverEnv = join(root, 'server.env');
const listener = net.createServer();
await new Promise<void>((accept) => listener.listen(0, '127.0.0.1', accept));
const address = listener.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((accept) => listener.close(() => accept()));
async function databaseReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await runCommand([
      'docker',
      'exec',
      '-e',
      `MYSQL_PWD=${dbPassword}`,
      database,
      'mysql',
      '--host=127.0.0.1',
      '--port=3307',
      '--user=gemwright',
      '--database=gemwright',
      '--execute=SELECT 1'
    ]);
    if (result.code === 0) return;
    await Bun.sleep(500);
  }
  throw new Error('MySQL did not become ready.');
}
async function ready(previous = 0) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const [state] = JSON.parse(await docker(['inspect', name]));
    if (!state.State.Running) throw new Error('Sphere exited during startup.');
    const logs = await docker(['logs', name]);
    if ((logs.match(/Startup complete/g) ?? []).length > previous) return;
    await Bun.sleep(500);
  }
  throw new Error('Sphere did not become ready.');
}
async function probe(action: 'write' | 'read') {
  const priorLogs = await docker(['logs', name]);
  const prior = (priorLogs.match(/GEMWRIGHT_MYSQL_READ=persisted/g) ?? []).length;
  const priorConsole = (priorLogs.match(/connected on remote admin console/g) ?? []).length;
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let output = '';
  socket.on('data', (data) => (output += data.toString('latin1')));
  socket.on('error', () => {});
  await new Promise<void>((accept, reject) => {
    socket.once('connect', accept);
    socket.once('error', reject);
  });
  async function prompt(text: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (output.includes(text)) {
        output = '';
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error(`Admin console did not show ${text}.`);
  }
  try {
    socket.write(' ');
    await prompt('Login:');
    socket.write('admin\r\n');
    await prompt('Password:');
    socket.write('test-password\r\n');
    if (emulator === 'sphere-x') await prompt('Welcome');
    else {
      let authenticated = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const logs = await docker(['logs', name]);
        if ((logs.match(/connected on remote admin console/g) ?? []).length > priorConsole) {
          authenticated = true;
          break;
        }
        await Bun.sleep(50);
      }
      assert.ok(authenticated, 'Classic Sphere admin login must succeed');
    }
    socket.write(`f_gemwright_mysql_${action}\r\n`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const logs = await docker(['logs', name]);
      if ((logs.match(/GEMWRIGHT_MYSQL_READ=persisted/g) ?? []).length > prior) return;
      await Bun.sleep(100);
    }
    throw new Error('Native DB.QUERY did not return the persisted row.');
  } finally {
    socket.destroy();
  }
}
try {
  if (!process.env.GEMWRIGHT_TEST_IMAGE) {
    const sources = await resolveLatestSphereSources(undefined, emulator);
    const sphere = {
      scriptsSource: sources.scripts,
      mysql: true,
      owner: 'admin',
      autoCreateAccounts: false,
      maps: 'expansion' as const,
      mapSize: 'modern' as const,
      clientEncryption: 'both' as const
    };
    const config = createConfig({ emulator, timezone: 'Europe/London', source: sources.server, sphere });
    const files = prepareSphereFiles(await fetchSphereFiles(sources), config, sphere, 'test-password');
    files['scripts/gemwright_mysql_test.scp'] = await readFile(new URL('./sphere/mysql.scp', import.meta.url));
    files['scripts/spheretables.scp'] = Buffer.from(
      Buffer.from(required(files['scripts/spheretables.scp'], 'scripts/spheretables.scp'))
        .toString('latin1')
        .replace('[RESOURCES]', `[RESOURCES]\n${emulator === 'sphere' ? 'scripts/' : ''}gemwright_mysql_test.scp`),
      'latin1'
    );
    const directory = join(root, 'shard');
    await saveInstance(directory, config, false, files);
    const context = await stageSphere(directory, config);
    await docker(['build', ...(emulator === 'sphere' ? ['--platform', 'linux/amd64'] : []), '-t', image, context]);
  }
  const missing = await runCommand([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/opt/sphere/spheresvr',
    image,
    '--mysql-env'
  ]);
  assert.notEqual(missing.code, 0, 'Missing database credentials must fail before startup');
  assert.match(missing.stderr + missing.stdout, /Missing MySQL environment variable/);
  await writeFile(
    dbEnv,
    `MYSQL_ROOT_PASSWORD=${randomUUID()}\nMYSQL_DATABASE=gemwright\nMYSQL_USER=gemwright\nMYSQL_PASSWORD=${dbPassword}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    serverEnv,
    `GEMWRIGHT_MYSQL=1\nMYSQLHOST=mysql\nMYSQLPORT=3307\nMYSQLUSER=gemwright\nMYSQLPASSWORD=${dbPassword}\nMYSQLDATABASE=gemwright\nRAILWAY_TCP_PROXY_DOMAIN=127.0.0.1\nRAILWAY_TCP_PROXY_PORT=${port}\n`,
    { mode: 0o600 }
  );
  await docker(['network', 'create', name]);
  await docker(['volume', 'create', database]);
  await docker(['volume', 'create', name]);
  await docker([
    'run',
    '-d',
    '--name',
    database,
    '--network',
    name,
    '--network-alias',
    'mysql',
    '--env-file',
    dbEnv,
    '--mount',
    `type=volume,source=${database},target=/var/lib/mysql`,
    'mysql:8.4',
    '--port=3307'
  ]);
  await databaseReady();
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    name,
    '--env-file',
    serverEnv,
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
  await probe('write');
  await docker(['restart', database]);
  await databaseReady();
  await probe('read');
  await docker(['stop', '-t', '30', name]);
  const [stopped] = JSON.parse(await docker(['inspect', name]));
  assert.equal(stopped.State.ExitCode, 0);
  await docker(['start', name]);
  await ready(1);
  await probe('read');
  const ini = await docker(['exec', name, 'cat', '/app/data/server/sphere.ini']);
  assert.ok(!ini.includes(dbPassword), 'Runtime sphere.ini must not contain the database password');
  console.log(
    `${emulator}: native MySQL 8.4 writes/queries, custom port, database restart, shard restart and credential isolation passed.`
  );
} catch (error) {
  console.error((await docker(['logs', name]).catch(() => 'No shard logs')).slice(-5000));
  throw error;
} finally {
  await docker(['rm', '-f', name, database]).catch(() => {});
  await docker(['volume', 'rm', name, database]).catch(() => {});
  await docker(['network', 'rm', name]).catch(() => {});
  if (!process.env.GEMWRIGHT_TEST_IMAGE) await docker(['image', 'rm', image]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
