import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type GameFile, parseManifest } from '../client/files';
import { command } from './process';

export async function createManifest(root: string): Promise<GameFile[]> {
  const files: GameFile[] = [];
  async function visit(directory: string, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Game files cannot contain symlinks: ${prefix}${entry.name}`);
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (entry.isFile() && /\.(mul|idx|uop|def|rle|txt|enu|mp3|mid|png)$/i.test(path)) {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(join(directory, entry.name))) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        files.push({ path, bytes, sha256: hash.digest('hex') });
      }
    }
  }
  await visit(root);
  if (!files.length) throw new Error('No game files found. Supply your own Ultima Online data files.');
  parseManifest({ files });
  return files;
}

export async function packageClientFiles(
  directory: string,
  sourcePath: string,
  pattern: RegExp,
  validate: (names: string[]) => void
): Promise<{ archive: string; digest: string; bytes: number }> {
  const source = resolve(sourcePath);
  const names = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  validate(names.map((name) => name.toLowerCase()));
  const hash = createHash('sha256');
  let bytes = 0;
  for (const name of names) {
    hash.update(name + '\0');
    for await (const chunk of createReadStream(join(source, name))) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  }
  const digest = hash.digest('hex');
  const archive = join(directory, '.gemwright', `client-${digest}.tar.gz`);
  if (!existsSync(archive)) await command(['tar', '--no-xattrs', '-czf', archive, '-C', source, ...names], directory);
  return { archive, digest, bytes };
}
