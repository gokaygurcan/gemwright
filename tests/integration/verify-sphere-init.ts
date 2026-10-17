import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitStatus } from '../../src/instance';

const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'gemwright-sphere-questionnaire-'));
async function drive(script: string): Promise<void> {
  const file = join(root, 'drive.exp');
  await writeFile(file, script);
  const child = Bun.spawn(['/usr/bin/expect', file], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  assert.equal(code, 0, stderr || stdout);
}
const setup = String.raw`log_user 0
set timeout 20
proc await {label} {
  expect {
    -exact $label {}
    timeout { puts stderr "Timed out waiting for $label"; exit 1 }
    eof { puts stderr "Exited before $label"; exit 1 }
  }
  after 100
}
`;
try {
  assert.equal((await gitStatus(root)).insideRepository, false, 'Questionnaire test must run outside a Git repository');
  const target = join(root, 'branch');
  await drive(
    setup +
      String.raw`
spawn sh -c {stty columns 100 rows 40; exec bun ${entry} init ${target} --timezone Europe/London --expansion uor}
await "Shard name"
send -- "\r"
await "Which server emulator?"
send -- "\033\[B"
after 100
send -- "\r"
await "Admin email"
send -- "\r"
await "Shard website"
send -- "\r"
set timeout 90
await "UO client files directory"
set timeout 20
send -- "\r"
await "Client encryption"
send -- "\r"
await "World maps"
send -- "\033\[B"
after 100
send -- "\r"
await "Which UO map files will you use?"
send -- "\033\[B"
after 100
send -- "\r"
await "Combat behavior"
send -- "\r"
await "Archery delay after movement"
send -- "\r"
await "Physical damage formula"
send -- "\r"
await "Hit chance formula"
send -- "\r"
await "Magic behavior"
send -- "\r"
await "Racial traits"
send -- "\r"
await "Reveal invisible characters"
send -- "\r"
await "NPC intelligence"
send -- "\r"
await "Allow players to create accounts"
send -- "\r"
await "Owner username"
send -- "sphere_owner\r"
await "Owner password"
send -- "Sphere-Password\r"
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
  const config = JSON.parse(await readFile(join(target, 'gemwright.json'), 'utf8'));
  assert.equal(config.name, 'Gemwright');
  assert.equal(config.id, 'gemwright');
  assert.equal(config.adminEmail, 'gemwright@example.com');
  assert.equal(config.url, 'www.example.com');
  assert.equal(config.emulator, 'sphere');
  assert.equal(config.sphere.maps, 'felucca');
  assert.equal(config.sphere.mapSize, 'legacy');
  assert.equal(config.sphere.owner, 'sphere_owner');
  assert.equal(config.sphere.autoCreateAccounts, false);
  assert.match(config.source.revision, /^[a-f0-9]{40}$/);
  assert.match(config.sphere.scriptsSource.revision, /^[a-f0-9]{40}$/);
  assert.equal(await Bun.file(join(target, '.git/HEAD')).exists(), false);
  assert.ok((await readFile(join(target, 'sphere.ini'), 'latin1')).includes('Map0=6144,4096,-1,0,0'));
  const tables = await readFile(join(target, 'scripts/spheretables.scp'), 'latin1');
  assert.ok(tables.includes('\r\n//scripts/maps/sphere_map0_ml.scp\r\n'));
  assert.ok(tables.includes('\r\n//scripts/maps/sphere_map1.scp\r\n'));
  const seed = await readFile(join(target, 'accounts/sphereaccu.scp'), 'utf8');
  assert.ok(seed.includes(createHash('md5').update('Sphere-Password').digest('hex')));
  assert.equal((await stat(join(target, 'accounts/sphereaccu.scp'))).mode & 0o777, 0o600);

  const custom = join(root, 'custom');
  await drive(
    setup +
      String.raw`
spawn sh -c {stty columns 100 rows 40; exec bun ${entry} init ${custom} --emulator sphere --name Rules --timezone Europe/Amsterdam --expansion ml}
await "Admin email"
send -- "owner@example.org\r"
await "Shard website"
send -- "www.example.org\r"
set timeout 90
await "UO client files directory"
set timeout 20
send -- "\r"
await "Client encryption"
send -- "\r"
await "World maps"
send -- "\r"
await "Combat behavior"
send -- "a\r"
await "Physical damage formula"
send -- "\033\[B\033\[B\r"
await "Hit chance formula"
send -- "\033\[B\033\[B\r"
await "Magic behavior"
send -- "a\r"
await "Racial traits"
send -- "a\r"
await "Reveal invisible characters"
send -- "a\r"
await "NPC intelligence"
send -- "a\r"
await "Allow players to create accounts"
send -- "\r"
await "Owner username"
send -- "\r"
await "Owner password"
send -- "Sphere-Password\r"
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
  const customConfig = JSON.parse(await readFile(join(custom, 'gemwright.json'), 'utf8'));
  assert.equal(customConfig.adminEmail, 'owner@example.org');
  assert.equal(customConfig.sphere.rules.combatFlags, 0x3fff);
  assert.equal(customConfig.sphere.rules.damageEra, 2);
  assert.equal(customConfig.sphere.rules.hitChanceEra, 2);
  assert.equal(customConfig.sphere.rules.speedEra, 0);
  assert.equal(customConfig.sphere.rules.speedScaleFactor, 15000);
  assert.equal(customConfig.sphere.rules.magicFlags, 0x1fff);
  assert.equal(customConfig.sphere.rules.racialFlags, 0x7ff);
  assert.equal(customConfig.sphere.rules.revealFlags, 0);
  assert.equal(customConfig.sphere.rules.npcAI, 0xf5f);
  const customIni = await readFile(join(custom, 'sphere.ini'), 'latin1');
  assert.ok(customIni.includes('TimeZone=-1'));
  assert.ok(customIni.includes('CombatSpeedEra=0'));
  const weapons = await readFile(join(custom, 'scripts/items/sphere_item_provisions_weapons.scp'), 'latin1');
  assert.match(weapons, /^\/\/TAG\.OVERRIDE\.SPEED=\d+/m);
  assert.doesNotMatch(weapons, /^TAG\.OVERRIDE\.SPEED=/m);

  const cancelled = join(root, 'cancelled');
  await drive(
    setup +
      String.raw`
spawn sh -c {stty columns 100 rows 40; exec bun ${entry} init ${cancelled} --emulator sphere --name Cancelled --timezone Europe/London --expansion tol}
await "Admin email"
send -- "\r"
await "Shard website"
send -- "\r"
set timeout 90
await "UO client files directory"
send -- "\003"
expect eof
set result [wait]
if {[lindex $result 3] != 130} { exit 1 }
`
  );
  assert.equal(
    await stat(cancelled).then(
      () => true,
      () => false
    ),
    false
  );
  console.log(
    'Sphere questionnaire: default rules, custom flags/formulas, moving-archery branch, upstream swing-speed defaults, legacy maps and cancellation passed.'
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
