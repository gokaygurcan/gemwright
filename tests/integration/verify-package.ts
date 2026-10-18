import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const node = await realpath(process.argv[2] ?? execFileSync('which', ['node'], { encoding: 'utf8' }).trim());
const npm = process.argv[3] ? resolve(process.argv[3]) : execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
const temporary = await mkdtemp(join(tmpdir(), 'gemwright-node-package-'));
try {
  const bin = join(temporary, 'bin');
  await mkdir(bin);
  await symlink(node, join(bin, 'node'));
  for (const name of ['git', 'tar']) {
    await symlink(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(bin, name));
  }
  const env = { ...process.env, PATH: bin, npm_config_cache: join(temporary, 'cache') };
  const run = (file: string, args: string[], cwd = temporary) =>
    execFileSync(file, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  assert.equal(execFileSync(node, ['-e', 'console.log(typeof Bun)'], { env, encoding: 'utf8' }).trim(), 'undefined');
  assert.equal(run('/bin/sh', ['-c', 'command -v bun || true']).trim(), '');
  const packed = JSON.parse(
    run(node, [await realpath(npm), 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], repository)
  );
  const pack = Array.isArray(packed) ? packed[0] : packed.gemwright;
  assert.deepEqual(
    pack.files
      .filter((file: { path: string }) => file.path.startsWith('dist/'))
      .map((file: { path: string }) => file.path),
    ['dist/index.js']
  );
  assert.ok(
    pack.files.every((file: { path: string }) => !file.path.startsWith('src/') && !file.path.startsWith('tests/'))
  );
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  run(node, [
    await realpath(npm),
    'install',
    '--prefix',
    consumer,
    join(temporary, pack.filename),
    '--no-audit',
    '--no-fund'
  ]);
  const cli = join(consumer, 'node_modules/.bin/gemwright');
  assert.match(run(cli, ['--help']), /gemwright deploy.*--client/);
  for (const path of [
    'client/Dockerfile',
    'client/build.ts',
    'client/.dockerignore',
    'client/.railwayignore',
    'client/web/main.ts',
    'client/runtime/_framework/dotnet.js',
    'client/runtime/licenses/WebClients.txt'
  ])
    assert.ok(
      pack.files.some((file: { path: string }) => file.path === path),
      `Missing web client file: ${path}`
    );
  assert.ok(pack.files.every((file: { path: string }) => !/^client\/(bundle|gamefiles|deploy\.ts)/.test(file.path)));

  await writeFile(
    join(bin, 'railway'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('railway test fixture');
else if (args[0] === 'whoami') console.log('{}');
else { console.error('STOP_BEFORE_PROVISIONING'); process.exitCode = 1; }
`
  );
  await chmod(join(bin, 'railway'), 0o755);
  for (const emulator of ['servuo', 'sphere']) {
    const shard = join(temporary, emulator);
    run(cli, ['init', shard, '--emulator', emulator, '--timezone', 'Europe/London', '--yes']);
    const config = JSON.parse(await readFile(join(shard, 'gemwright.json'), 'utf8'));
    assert.equal(config.emulator, emulator);
    assert.match(config.source.revision, /^[a-f0-9]{40}$/);
    assert.throws(
      () => run(cli, ['deploy', '--client'], shard),
      (error: unknown) => /requires --files/.test(String((error as { stderr?: string }).stderr))
    );
    try {
      run(cli, ['deploy'], shard);
      assert.fail('Deployment must stop at the fake Railway CLI');
    } catch (error) {
      assert.match(String((error as { stderr?: string }).stderr), /STOP_BEFORE_PROVISIONING/);
    }
    const context = join(shard, '.gemwright/deploy');
    assert.match(await readFile(join(context, 'Dockerfile'), 'utf8'), /FROM/);
    assert.match(await readFile(join(context, 'start.sh'), 'utf8'), /^#!\/bin\/sh/);
    const ini = emulator === 'sphere' ? 'sphere.ini' : 'Config/Server.cfg';
    const staged = emulator === 'sphere' ? join(context, 'shard', ini) : join(context, 'server', ini);
    assert.deepEqual(await readFile(staged), await readFile(join(shard, ini)));
    console.log(`${emulator}: installed CLI initialized and staged successfully under Node without Bun.`);
  }
  const interactive = join(temporary, 'interactive');
  const expectFile = join(temporary, 'questionnaire.exp');
  await writeFile(
    expectFile,
    String.raw`log_user 1
set timeout 20
proc await {label} {
  expect {
    -exact $label {}
    timeout { puts stderr "Timed out waiting for $label"; exit 1 }
    eof { puts stderr "Exited before $label"; exit 1 }
  }
  after 100
}
spawn /bin/sh -c {/bin/stty columns 100 rows 40; exec ${cli} init ${interactive} --name Questionnaire --emulator servuo --timezone Europe/London --expansion ej}
await "Admin email"
send -- "\r"
await "Shard website"
send -- "\r"
set timeout 90
await "UO client files directory"
set timeout 20
send -- "\r"
await "Allow players to create accounts"
send -- "\r"
await "Accounts allowed per IP address"
send -- "\r"
await "Enable global chat?"
send -- "\r"
await "Allowed clients"
send -- "\r"
await "Owner username"
send -- "\r"
await "Owner password"
send -- "Package-Password\r"
await "Initialize a Git repository?"
send -- "\033\[C"
after 100
send -- "\r"
await "Created gemwright.json"
expect eof
set result [wait]
exit [lindex $result 3]
`
  );
  run('/usr/bin/expect', [expectFile]);
  const questionnaire = JSON.parse(await readFile(join(interactive, 'gemwright.json'), 'utf8'));
  assert.equal(questionnaire.name, 'Questionnaire');
  assert.equal(questionnaire.servuo.owner, 'admin');
  console.log('Interactive installed CLI questionnaire passed under Node without Bun.');
  console.log(
    'npm package installation, executable, both emulator patches and runtime assets passed; no Railway resources created.'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
