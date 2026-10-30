import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { stageImage } from '../../src/assets';
import { withServicePackages } from '../../src/service-packages';

const repository = resolve(import.meta.dirname, '../../../..');
const temporary = await mkdtemp(join(tmpdir(), 'gemwright-services-'));
const env = { ...process.env, npm_config_cache: join(temporary, 'cache') };
const run = (args: string[], cwd = temporary) =>
  execFileSync(args[0] ?? '', args.slice(1), { cwd, env, encoding: 'utf8', timeout: 120000 });
const children: ReturnType<typeof Bun.spawn>[] = [];
let registry: ReturnType<typeof Bun.serve> | undefined;
try {
  const paths: Record<string, string> = {};
  for (const component of ['ai', 'client', 'server']) {
    const output = JSON.parse(
      run(
        ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
        join(repository, 'packages', component)
      )
    );
    const pack = Array.isArray(output) ? output[0] : output[`@gemwright/${component}`];
    assert.equal(pack.name, `@gemwright/${component}`);
    const files = new Set(pack.files.map((file: { path: string }) => file.path));
    assert.ok(files.has('LICENSE'), `Missing project license in ${component}`);

    assert.ok(
      pack.files.every(
        (file: { path: string }) =>
          !/(^|\/)(node_modules|data|Saves|Backups|Logs|\.env|\.npmrc|\.git)(\/|$)|\.sqlite(?:-|$)/.test(file.path)
      )
    );
    const consumer = join(temporary, `installed-${component}`);
    await mkdir(consumer);
    run([
      'npm',
      'install',
      '--prefix',
      consumer,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temporary, pack.filename)
    ]);
    assert.equal(
      JSON.parse(await readFile(join(consumer, 'node_modules', '@gemwright', component, 'package.json'), 'utf8'))
        .version,
      pack.version
    );
    const target = join(temporary, component);
    await mkdir(target);
    run(['tar', '-xzf', join(temporary, pack.filename), '-C', target]);
    paths[component] = join(target, 'package');
    const secrets = ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN']
      .map((name) => ({ name, value: process.env[name] }))
      .filter((entry) => entry.value && entry.value.length >= 12);
    for (const file of pack.files as { path: string }[]) {
      const bytes = await readFile(join(target, 'package', file.path));
      for (const secret of secrets)
        assert.ok(!bytes.includes(secret.value ?? ''), `Embedded credential: ${secret.name}`);
    }
  }
  const server = paths.server ?? '';
  run([
    'node',
    '--input-type=module',
    '-e',
    `const p=await import(${JSON.stringify(pathToFileURL(join(server, 'dist/staging.js')).href)}); if(Object.keys(p.deployments).length!==5)process.exit(1)`
  ]);
  console.log('Packed server integration imports under Node outside the workspace, with all five emulator adapters.');

  const ai = paths.ai ?? '';
  run([
    process.execPath,
    join(ai, 'dist/index.js'),
    'validate',
    '--config',
    join(ai, 'templates/population.example.json')
  ]);
  const data = join(temporary, 'residents');
  const child = Bun.spawn([process.execPath, join(ai, 'dist/serve.js')], {
    cwd: temporary,
    env: {
      ...env,
      AI_DATA: data,
      UO_HOST: '127.0.0.1',
      GEMWRIGHT_SHARD: JSON.stringify({ id: 'standalone', emulator: 'servuo', expansion: 'ej', ai: { population: 0 } })
    },
    stdout: 'ignore',
    stderr: 'pipe'
  });
  children.push(child);
  for (let attempt = 0; attempt < 100 && !(await Bun.file(join(data, '.ai-ready')).exists()); attempt++)
    await Bun.sleep(50);
  assert.ok(await Bun.file(join(data, '.ai-ready')).exists(), 'Packed AI failed to bootstrap');
  await Bun.sleep(200);
  child.kill('SIGTERM');
  assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  assert.ok(await Bun.file(join(data, 'residents.sqlite')).exists());
  console.log('Packed AI validates, bootstraps, persists and shuts down without CLI/common/network installations.');

  const gameFiles = join(temporary, 'gamefiles');
  await mkdir(gameFiles);
  await writeFile(join(gameFiles, 'map0.mul'), 'map');
  await writeFile(
    join(gameFiles, 'manifest.json'),
    JSON.stringify({
      files: [{ path: 'map0.mul', bytes: 3, sha256: createHash('sha256').update('map').digest('hex') }]
    })
  );
  const { startClient, loadConfig } = await import(pathToFileURL(join(paths.client ?? '', 'bundle/server.js')).href);
  const app = startClient(
    loadConfig({
      UO_HOST: '127.0.0.1',
      UO_PORT: '2593',
      GAMEFILES_PATH: gameFiles,
      PORT: '0',
      CLIENT_LISTEN_HOST: '127.0.0.1'
    })
  );
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ready, true);
    assert.equal((await fetch(`http://127.0.0.1:${app.server.port}/_framework/dotnet.js`)).status, 200);
  } finally {
    await app.stop();
  }
  console.log('Packed client serves readiness and browser runtime independently of the CLI.');

  // A local npm registry serves a newer AI release to the unchanged CLI retrieval path.
  const manifestPath = join(ai, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const [major, minor] = manifest.version.split('.').map(Number);
  const candidate = `${major}.${minor + 1}.0`;
  manifest.version = candidate;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = JSON.parse(run(['npm', 'pack', ai, '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const newer = Array.isArray(result) ? result[0] : result['@gemwright/ai'];
  const tarball = await readFile(join(temporary, newer.filename));
  registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/ai.tgz') return new Response(tarball);
      return Response.json({
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: {
          [manifest.version]: { ...manifest, dist: { tarball: `${registry?.url}ai.tgz`, integrity: newer.integrity } }
        }
      });
    }
  });
  let fetchedPath = '';
  await withServicePackages(
    {
      name: 'Standalone',
      id: 'standalone',
      timezone: 'Europe/London',
      emulator: 'servuo',
      expansion: 'ej',
      schemaVersion: 1,
      packages: { ai: candidate }
    },
    ['ai'],
    async (selected) => {
      fetchedPath = selected.ai ?? '';
      assert.equal(JSON.parse(await readFile(join(fetchedPath, 'package.json'), 'utf8')).version, candidate);
      const context = join(temporary, 'selected-ai-context');
      await mkdir(context);
      await stageImage('ai', context, undefined, fetchedPath);
      assert.ok(await Bun.file(join(context, 'dist/path-worker.js')).exists());
      assert.equal(await Bun.file(join(context, 'bun.lock')).exists(), false);
    },
    async (args, cwd) => {
      if (args[0] === 'npm') args = [...args, '--registry', String(registry?.url)];
      const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]);
      if (code !== 0) throw new Error(stderr || stdout);
      return stdout;
    }
  );
  assert.equal(await Bun.file(join(fetchedPath, 'package.json')).exists(), false, 'Temporary package must be cleaned');
  console.log(
    `Unchanged CLI retrieved exact AI ${candidate} from a local registry and staged only that contained artifact.`
  );

  if (process.argv[2]) {
    for (const component of ['ai', 'client']) {
      const target = join(resolve(process.argv[2]), component);
      await mkdir(target, { recursive: true });
      await stageImage(component as 'ai' | 'client', target, undefined, paths[component]);
    }
  }
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await registry?.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
