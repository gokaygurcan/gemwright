import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { command } from '../process';

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
