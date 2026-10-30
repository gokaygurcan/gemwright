import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const wrapperRepository = resolve(repository, '../gemwright');
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
  const env = { ...process.env, NO_UPDATE_NOTIFIER: '1', PATH: bin, npm_config_cache: join(temporary, 'cache') };
  const run = (file: string, args: string[], cwd = temporary) =>
    execFileSync(file, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  assert.equal(execFileSync(node, ['-e', 'console.log(typeof Bun)'], { env, encoding: 'utf8' }).trim(), 'undefined');
  assert.equal(run('/bin/sh', ['-c', 'command -v bun || true']).trim(), '');
  const packed = JSON.parse(
    run(node, [await realpath(npm), 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], repository)
  );
  const pack = Array.isArray(packed) ? packed[0] : packed['@gemwright/cli'];
  assert.deepEqual(
    pack.files
      .filter((file: { path: string }) => file.path.startsWith('dist/'))
      .map((file: { path: string }) => file.path),
    ['dist/index.js']
  );
  assert.ok(
    pack.files.every((file: { path: string }) => !file.path.startsWith('src/') && !file.path.startsWith('tests/'))
  );
  const wrapperResult = JSON.parse(
    run(
      node,
      [await realpath(npm), 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      wrapperRepository
    )
  );
  const wrapperPack = Array.isArray(wrapperResult) ? wrapperResult[0] : wrapperResult.gemwright;
  assert.ok(
    wrapperPack.files.every((file: { path: string }) => !/^(src|tests|workspace|templates|patches)\//.test(file.path))
  );
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  run(node, [
    await realpath(npm),
    'install',
    '--prefix',
    consumer,
    join(temporary, pack.filename),
    join(temporary, wrapperPack.filename),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ]);
  const cli = join(consumer, 'node_modules/.bin/gemwright');
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/gemwright/package.json'), 'utf8'));
  const scoped = join(consumer, 'node_modules/.bin/gemwright-cli');
  assert.equal(installed.dependencies['@gemwright/cli'], installed.version);
  for (const entry of [cli, scoped]) {
    assert.equal(run(entry, ['--version']).trim(), installed.version);
    assert.equal(run(entry, ['--help']), run(cli, ['--help']));
    assert.throws(
      () => run(entry, ['unknown-command']),
      (error: unknown) => {
        const result = error as { status: number; stderr: string };
        return result.status === 1 && /Unknown command/.test(result.stderr);
      }
    );
    assert.throws(
      () => run(entry, ['--unknown-option']),
      (error: unknown) => {
        const result = error as { status: number; stderr: string };
        return result.status === 1 && /Unknown option/.test(result.stderr);
      }
    );
    for (const signal of ['INT', 'TERM']) {
      const driver = join(temporary, `signal-${signal}.exp`);
      await writeFile(
        driver,
        `set timeout 10
spawn /bin/sh -c {/bin/stty columns 100 rows 40; exec ${entry} init ${join(temporary, 'cancelled')} --emulator servuo --timezone Europe/London --expansion ej}
expect {
  -exact "Shard name" {}
  timeout {exit 1}
  eof {exit 1}
}
after 100
${signal === 'INT' ? 'send -- "\\003"' : 'exec /bin/kill -TERM [exp_pid]'}
expect eof
set result [wait]
${signal === 'INT' ? 'if {[lindex $result 3] != 130} {puts stderr $result; exit 1}' : 'if {[lindex $result 4] ne "CHILDKILLED" || [lindex $result 5] ne "SIGTERM"} {puts stderr $result; exit 1}'}
`
      );
      run('/usr/bin/expect', [driver]);
    }
  }
  assert.equal(
    run(
      node,
      [
        '--input-type=module',
        '-e',
        "import {main,run} from '@gemwright/cli'; if(typeof main !== 'function' || typeof run !== 'function') process.exit(1)"
      ],
      consumer
    ),
    ''
  );
  assert.equal(
    run(node, [join(consumer, 'node_modules/@gemwright/cli/dist/index.js'), '--version']).trim(),
    pack.version
  );
  console.log('Both isolated entry points preserve help/version, argument failures, cancellation and SIGTERM.');
  for (const path of [
    'workspace/packages/client/Dockerfile',
    'workspace/packages/client/bundle/server.js',
    'workspace/packages/client/.dockerignore',
    'workspace/packages/client/.railwayignore',
    'workspace/packages/client/bundle/public/main.js',
    'workspace/packages/client/bundle/public/_framework/dotnet.js'
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
  for (const emulator of ['servuo', 'sphere', 'sphere-x', 'runuo', 'modernuo']) {
    const shard = join(temporary, emulator);
    const mysql = emulator === 'sphere' || emulator === 'sphere-x';
    run(cli, [
      'init',
      shard,
      '--emulator',
      emulator,
      '--timezone',
      'Europe/London',
      '--yes',
      ...(mysql ? ['--mysql'] : [])
    ]);
    const config = JSON.parse(await readFile(join(shard, 'gemwright.json'), 'utf8'));
    assert.equal(config.emulator, emulator);
    assert.match(config.source.revision, /^[a-f0-9]{40}$/);
    if (mysql) assert.equal(config.sphere.mysql, true);
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
    if (mysql) assert.match(await readFile(join(context, 'Dockerfile'), 'utf8'), /ENV GEMWRIGHT_MYSQL=1/);
    assert.match(await readFile(join(context, 'start.sh'), 'utf8'), /^#!\/bin\/sh/);
    const sphere = emulator === 'sphere' || emulator === 'sphere-x';
    const ini = sphere
      ? 'sphere.ini'
      : emulator === 'runuo'
        ? 'Scripts/Misc/DataPath.cs'
        : emulator === 'modernuo'
          ? 'Configuration/modernuo.json'
          : 'Config/Server.cfg';
    const staged = sphere
      ? join(context, 'shard', ini)
      : join(context, 'server', ...(emulator === 'modernuo' ? ['Distribution'] : []), ini);
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
    'npm package installation, executable, all enabled emulator patches and runtime assets passed; no Railway resources created.'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
