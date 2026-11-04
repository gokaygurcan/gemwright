import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { command } from './process';

// The shard's world files the AI residents learn the land from (Spawns/*.xml, Regions.xml,
// Decoration/**/*.cfg and teleporters.csv),
// archived under a digest of their names and contents: the volume copy is replaced only when they change.
export async function packageWorldFiles(
  directory: string,
  staged: string
): Promise<{ archive: string; digest: string; files: number }> {
  const names: string[] = [];
  const visit = async (folder: string) => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory()) await visit(join(folder, entry.name));
      else if (entry.isFile() && /\.(xml|cfg|graph|csv)$/i.test(entry.name))
        names.push(relative(staged, join(folder, entry.name)));
  };
  await visit(staged);
  const required = ['Regions.xml', 'teleporters.csv'];
  if (
    !names.some((name) => name.startsWith('Spawns/')) ||
    !names.some((name) => name.startsWith('Decoration/')) ||
    required.some((name) => !names.includes(name))
  )
    throw new Error('AI world files need Spawns/, Decoration/, Regions.xml and teleporters.csv.');
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(`${name}\0`);
    for await (const chunk of createReadStream(join(staged, name))) hash.update(chunk);
  }
  const digest = hash.digest('hex');
  const archive = join(directory, '.gemwright', `world-${digest}.tar.gz`);
  if (!existsSync(archive)) await command(['tar', '--no-xattrs', '-czf', archive, '-C', staged, ...names], directory);
  return { archive, digest, files: names.length };
}
