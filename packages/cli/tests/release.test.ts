import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { announcement, type Package, type Plan, packages, publishPacked } from '../../../.changeset/release';

const root = resolve(import.meta.dirname, '../../..');
const binary = join(root, 'node_modules/@changesets/cli/bin.js');
const configuration = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
function fixture(input: Omit<Package, 'dir'>[], productionGroup = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gemwright-release-'));
  temporary.push(dir);
  for (const folder of ['packages', '.changeset', 'bin', 'registry', 'pack/packages'])
    mkdirSync(join(dir, folder), { recursive: true });
  write(join(dir, 'bun.lock'), {});
  write(join(dir, 'package.json'), {
    name: 'release-fixture',
    private: true,
    workspaces: ['packages/*'],
    packageManager: 'bun@1.4.3'
  });
  write(join(dir, '.changeset/config.json'), {
    ...configuration,
    changelog: false,
    fixed: productionGroup ? configuration.fixed : [input.map((pkg) => pkg.name)]
  });
  for (const [index, pkg] of input.entries()) {
    const target = join(dir, 'packages', `p${index}`);
    mkdirSync(target);
    write(join(target, 'package.json'), pkg);
    writeFileSync(join(target, 'CHANGELOG.md'), `# ${pkg.name}\n\n## ${pkg.version}\n\nFixture change.\n`);
  }
  const npm = join(dir, 'bin/npm');
  writeFileSync(
    npm,
    `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const directory=process.env.FIXTURE_REGISTRY;
if(!directory) throw new Error('Fixture registry is required');
const [command,name]=process.argv.slice(2);
const marker=(name)=>join(directory,encodeURIComponent(name)+'.published');
if(command==='info') {
  appendFileSync(join(directory,'info.log'),name+'\\n');
  if(process.env.FAIL_INFO) { console.log(JSON.stringify({error:{code:'EAI_AGAIN',summary:'Fixture registry unavailable'}}));process.exit(1); }
  if(!existsSync(marker(name))) {console.log(JSON.stringify({error:{code:'E404',summary:'Fixture package absent'}}));process.exit(1);}
  const version=readFileSync(marker(name),'utf8');console.log(JSON.stringify({versions:[version],'dist-tags':{latest:version}}));
} else if(command==='publish') {
  const pkg=JSON.parse(readFileSync(resolve(name),'utf8'));
  appendFileSync(join(directory,'attempts.log'),pkg.name+'\\n');
  const failures=JSON.parse(readFileSync(join(directory,'failures.json'),'utf8'));
  if(failures.includes(pkg.name)) {console.log(JSON.stringify({error:{code:'EFIXTURE',summary:'Fixture publish failed'}}));process.exit(1);}
  if(existsSync(marker(pkg.name))) throw new Error('Already-published package was retried');
  writeFileSync(marker(pkg.name),pkg.version);console.log('{}');
} else throw new Error('Unsupported fixture npm command: '+command);
`
  );
  chmodSync(npm, 0o755);
  write(join(dir, 'registry/failures.json'), []);
  const env = {
    ...process.env,
    FIXTURE_REGISTRY: join(dir, 'registry'),
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`
  };
  const run = (args: string[], extra = {}) => {
    try {
      execFileSync(process.execPath, [binary, ...args], { cwd: dir, env: { ...env, ...extra }, stdio: 'pipe' });
    } catch (error) {
      const output = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`${output.stdout ?? ''}${output.stderr ?? ''}`);
    }
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgSign', 'false']);
  git(['config', 'core.fsmonitor', 'false']);
  git(['config', 'user.name', 'Release fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['add', 'package.json', 'packages', '.changeset']);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Fixture baseline']);
  git(['remote', 'add', 'origin', dir]);
  const plan = () => {
    run(['publish-plan', '--output', join(dir, 'plan.json')]);
    return read(join(dir, 'plan.json')) as Plan;
  };
  const pack = () => {
    const result = plan();
    for (const release of result.plan.flat()) {
      const file = `packages/${encodeURIComponent(release.name)}.tgz`;
      const contents = JSON.stringify({ name: release.name, version: release.version });
      writeFileSync(join(dir, 'pack', file), contents);
      release.tarball = { path: file, integrity: `sha256-${createHash('sha256').update(contents).digest('base64')}` };
    }
    write(join(dir, 'pack/publish-plan.json'), result);
    return result;
  };
  return { dir, run, git, plan, pack };
}

test('a private common change versions the entire real package group and keeps the public dependency exact', () => {
  const source = packages();
  expect(new Set(source.map((pkg) => pkg.version)).size).toBe(1);
  expect(source.find((pkg) => pkg.name === 'gemwright')?.dependencies?.['@gemwright/cli']).toBe(
    source.find((pkg) => pkg.name === '@gemwright/cli')?.version
  );
  const names = new Set(source.map((pkg) => pkg.name));
  const value = fixture(
    source.map(({ dir: _, ...pkg }) => ({
      ...pkg,
      version: '0.7.0',
      dependencies: Object.fromEntries(
        Object.entries(pkg.dependencies ?? {})
          .filter(([name]) => names.has(name))
          .map(([name, range]) => [name, range.startsWith('workspace:') ? range : '0.7.0'])
      ),
      devDependencies: Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).filter(([name]) => names.has(name)))
    })),
    true
  );
  writeFileSync(join(value.dir, '.changeset/common-fix.md'), '---\n"@gemwright/common": patch\n---\n\nCommon fix.\n');
  value.run(['version']);
  const updated = packages(value.dir);
  expect(new Set(updated.map((pkg) => pkg.version))).toEqual(new Set(['0.7.1']));
  expect(updated.find((pkg) => pkg.name === 'gemwright')?.dependencies?.['@gemwright/cli']).toBe('0.7.1');
  rmSync(join(value.dir, 'bun.lock'));
  execFileSync(
    process.execPath,
    ['install', '--lockfile-only', '--ignore-scripts', '--cache-dir', join(value.dir, 'cache')],
    {
      cwd: value.dir,
      stdio: 'pipe'
    }
  );
  const lock = readFileSync(join(value.dir, 'bun.lock'), 'utf8');
  execFileSync(
    process.execPath,
    ['install', '--lockfile-only', '--ignore-scripts', '--frozen-lockfile', '--cache-dir', join(value.dir, 'cache')],
    {
      cwd: value.dir,
      stdio: 'pipe'
    }
  );
  expect(readFileSync(join(value.dir, 'bun.lock'), 'utf8')).toBe(lock);
  const plan = value.plan();
  expect(
    plan.plan
      .flat()
      .map((pkg) => pkg.name)
      .sort()
  ).toEqual(
    source
      .filter((pkg) => !pkg.private)
      .map((pkg) => pkg.name)
      .sort()
  );
  expect(plan.plan.findIndex((chunk) => chunk.some((pkg) => pkg.name === '@gemwright/cli'))).toBeLessThan(
    plan.plan.findIndex((chunk) => chunk.some((pkg) => pkg.name === 'gemwright'))
  );
  expect(readFileSync(join(value.dir, 'registry/info.log'), 'utf8')).not.toContain('@gemwright/common');
});

test('three publications survive two failures; retry publishes only missing versions and repairs metadata without republishing', async () => {
  const names = ['a', 'b', 'c', 'd', 'e'].map((name) => `@gemwright/fixture-${name}`);
  const value = fixture([
    ...names.map((name) => ({ name, version: '0.7.1' })),
    { name: '@gemwright/internal', version: '0.7.1', private: true }
  ]);
  value.pack();
  const failures = names.filter((_, index) => index === 1 || index === 3);
  write(join(value.dir, 'registry/failures.json'), failures);
  expect(() => publishPacked(value.dir, join(value.dir, 'pack'), value.run)).toThrow();
  expect(
    value
      .plan()
      .plan.flat()
      .map((pkg) => pkg.name)
      .sort()
  ).toEqual([...failures].sort());
  await expect(
    announcement(
      value.dir,
      value.run,
      async () => {
        throw new Error('Announcement ran before publication finished');
      },
      { tries: 1, settle: async () => {} }
    )
  ).rejects.toThrow('still missing');
  expect(value.git(['tag', '--list'])).toBe('');
  write(join(value.dir, 'registry/failures.json'), []);
  publishPacked(value.dir, join(value.dir, 'pack'), value.run);
  const attempts = readFileSync(join(value.dir, 'registry/attempts.log'), 'utf8').trim().split('\n');
  expect(attempts.slice(0, 5).sort()).toEqual([...names].sort());
  expect(attempts.slice(5).sort()).toEqual([...failures].sort());
  const releases = new Set<string>();
  const lookup = async (tag: string) => releases.has(tag);
  const first = await announcement(value.dir, value.run, lookup);
  expect(first).toHaveLength(5);
  for (const event of first.slice(0, 3)) releases.add(event.tag);
  const retry = await announcement(value.dir, value.run, lookup);
  expect(retry).toHaveLength(2);
  for (const event of retry) releases.add(event.tag);
  expect(await announcement(value.dir, value.run, lookup)).toEqual([]);
  expect(value.git(['tag', '--list']).split('\n')).toHaveLength(5);
  expect(readFileSync(join(value.dir, 'registry/attempts.log'), 'utf8').trim().split('\n')).toHaveLength(7);
});

test('bad artifact integrity and registry failures stop before publication', () => {
  const value = fixture([{ name: '@gemwright/fixture', version: '0.7.1' }]);
  const plan = value.pack();
  const artifact = join(value.dir, 'pack', plan.plan[0]?.[0]?.tarball?.path ?? 'missing');
  const contents = readFileSync(artifact);
  writeFileSync(artifact, 'changed');
  expect(() => publishPacked(value.dir, join(value.dir, 'pack'), value.run)).toThrow('integrity');
  writeFileSync(artifact, contents);
  expect(() =>
    publishPacked(value.dir, join(value.dir, 'pack'), (args) => value.run(args, { FAIL_INFO: '1' }))
  ).toThrow();
  expect(() => readFileSync(join(value.dir, 'registry/attempts.log'))).toThrow();
});

test('announcement waits for versions the registry does not show yet', async () => {
  const value = fixture([{ name: '@gemwright/fixture', version: '0.7.1' }]);
  value.pack();
  const settle = async () => publishPacked(value.dir, join(value.dir, 'pack'), value.run);
  expect(await announcement(value.dir, value.run, async () => false, { tries: 2, settle })).toHaveLength(1);
});
