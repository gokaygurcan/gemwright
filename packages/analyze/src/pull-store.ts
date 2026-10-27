import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The pulls in a shard folder's .gemwright/pulls (gemwright pull), for the pulls page: what each
// holds, its size, and deleting one.
export interface PullInfo {
  stamp: string;
  at: Date;
  bytes: number;
  saves: boolean;
  parts: string[];
  failed: string[];
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export const pullsDir = (directory = process.cwd()) => resolve(directory, '.gemwright/pulls');
export const savesOf = (stamp: string, directory = process.cwd()) => join(pullsDir(directory), stamp, 'server/Saves');
export const isStamp = (stamp: string) => STAMP.test(stamp);
const dateOf = (stamp: string) => new Date(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

export function listPulls(directory = process.cwd()): PullInfo[] {
  const root = pullsDir(directory);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(isStamp)
    .sort()
    .reverse()
    .map((stamp) => {
      const folder = join(root, stamp);
      let entries: { part: string; error?: string }[] = [];
      try {
        entries = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).entries ?? [];
      } catch {}
      const du = Bun.spawnSync(['du', '-sk', folder]).stdout.toString();
      return {
        stamp,
        at: dateOf(stamp),
        bytes: Number(du.split('\t')[0] ?? 0) * 1024,
        saves: existsSync(join(folder, 'server/Saves/Mobiles')),
        // Without a manifest (an interrupted pull), the folders that came down.
        parts: entries.length
          ? [...new Set(entries.filter((e) => !e.error).map((e) => e.part))]
          : ['server', 'ai', 'logs'].filter((part) => existsSync(join(folder, part))),
        failed: [...new Set(entries.filter((e) => e.error).map((e) => e.part))]
      };
    });
}

export function deletePull(stamp: string, directory = process.cwd()) {
  if (!isStamp(stamp)) throw new Error('Not a pull');
  rmSync(join(pullsDir(directory), stamp), { recursive: true, force: true });
}
