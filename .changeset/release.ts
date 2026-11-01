import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Package {
  dir: string;
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Release {
  kind: string;
  name: string;
  version: string;
  tarball?: { path: string; integrity: string };
}
export interface Plan {
  version: number;
  plan: Release[][];
}
type Run = (args: string[]) => void;
const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'node_modules/@changesets/cli/bin.js');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const runChangesets = (cwd: string, args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' });

export function packages(cwd = root): Package[] {
  return readdirSync(join(cwd, 'packages'))
    .filter((dir) => existsSync(join(cwd, 'packages', dir, 'package.json')))
    .map((dir) => ({ ...json(join(cwd, 'packages', dir, 'package.json')), dir: join(cwd, 'packages', dir) }));
}
function freshPlan(run: Run): Plan {
  const temporary = mkdtempSync(join(tmpdir(), 'gemwright-publish-plan-'));
  try {
    const file = join(temporary, 'publish-plan.json');
    run(['publish-plan', '--output', file]);
    const plan = json(file) as Plan;
    assert.equal(plan.version, 1, 'Unsupported Changesets publish plan');
    assert.ok(Array.isArray(plan.plan), 'Invalid Changesets publish plan');
    return plan;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function publishPacked(cwd: string, directory: string, run: Run = (args) => runChangesets(cwd, args)): void {
  const list = packages(cwd);
  const original = json(join(directory, 'publish-plan.json')) as Plan;
  assert.equal(original.version, 1, 'Unsupported packed plan');
  assert.ok(Array.isArray(original.plan), 'Invalid packed plan');
  const packed = new Set<string>();
  for (const release of original.plan.flat()) {
    const pkg = list.find((entry) => entry.name === release.name);
    assert.ok(pkg && !pkg.private && pkg.version === release.version, 'Packed package differs from release checkout');
    assert.equal(release.kind, 'publish');
    assert.ok(release.tarball, 'Missing packed artifact');
    const file = resolve(directory, release.tarball.path);
    assert.ok(file.startsWith(resolve(directory) + sep), 'Artifact path escapes pack directory');
    assert.equal(
      `sha256-${createHash('sha256').update(readFileSync(file)).digest('base64')}`,
      release.tarball.integrity,
      'Artifact integrity mismatch'
    );
    packed.add(`${release.name}@${release.version}`);
  }
  const pending = freshPlan(run).plan.flat();
  const missing = new Set(pending.map((release) => `${release.name}@${release.version}`));
  for (const key of missing) assert.ok(packed.has(key), `No original artifact for ${key}`);
  const plan = original.plan
    .map((chunk) => chunk.filter((release) => missing.has(`${release.name}@${release.version}`)))
    .filter((chunk) => chunk.length);
  if (!plan.length) {
    console.log('All intended public versions are already published.');
    return;
  }
  writeFileSync(join(directory, 'publish-plan.json'), JSON.stringify({ version: 1, plan }));
  run(['publish', '--from-pack-dir', directory, '--no-git-tag']);
}
export async function announcement(
  cwd: string,
  run: Run = (args) => runChangesets(cwd, args),
  releaseExists: (tag: string) => Promise<boolean> = async (tag) => {
    assert.ok(process.env.GITHUB_REPOSITORY && process.env.GITHUB_TOKEN, 'Missing GitHub action context');
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
      }
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`);
    return true;
  },
  // npm shows a new version only minutes after publication (longest for the large CLI package):
  // look again for up to 15 minutes before calling a version missing.
  wait = { tries: 30, settle: () => sleep(30_000) }
) {
  const list = packages(cwd);
  let unpublished = freshPlan(run).plan.flat().length;
  for (let attempt = 1; unpublished > 0 && attempt < wait.tries; attempt++) {
    await wait.settle();
    unpublished = freshPlan(run).plan.flat().length;
  }
  assert.equal(unpublished, 0, 'Public versions are still missing from npm; no announcement');
  const missing = [];
  for (const pkg of list.filter((entry) => !entry.private)) {
    assert.ok(
      readFileSync(join(pkg.dir, 'CHANGELOG.md'), 'utf8').includes(`## ${pkg.version}`),
      `Missing changelog for ${pkg.name}`
    );
    const tag = `${pkg.name}@${pkg.version}`;
    if (!(await releaseExists(tag))) missing.push({ type: 'git-tag', tag, packageName: pkg.name });
  }
  // Native Changesets owns annotated tags; the action receives only missing releases, including retries of existing tags.
  run(['git-tag']);
  return missing;
}
if (import.meta.main) {
  const [command, directory] = process.argv.slice(2);
  if (command === 'publish') {
    assert.ok(directory, 'A downloaded Changesets pack directory is required');
    publishPacked(root, resolve(directory));
  } else if (command === 'announce') {
    const output = process.env.CHANGESETS_OUTPUT;
    assert.ok(output, 'Run announcement through the Changesets publish action');
    const events = await announcement(root, (args) => {
      const { CHANGESETS_OUTPUT: _, ...env } = process.env;
      execFileSync(process.execPath, [cli, ...args], { cwd: root, env, stdio: 'inherit' });
    });
    writeFileSync(output, events.map((event) => JSON.stringify(event)).join('\n'));
  } else throw new Error('Expected publish or announce');
}
