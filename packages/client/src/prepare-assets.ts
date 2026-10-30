import { createReadStream, createWriteStream } from 'node:fs';
import { cp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress } from 'node:zlib';

async function compress(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compress(path);
    else if (entry.isFile() && /\.(wasm|m?js|json|css|html|txt)$/i.test(entry.name)) {
      await pipeline(
        createReadStream(path),
        createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
        createWriteStream(`${path}.br`)
      );
    }
  }
}

const root = resolve(import.meta.dirname, '..');
const staged = join(root, 'bundle.next');
try {
  const publicPath = join(staged, 'public');
  await cp(join(root, 'runtime'), publicPath, { recursive: true });
  await cp(join(root, 'web'), publicPath, { recursive: true, filter: (path) => !path.endsWith('.ts') });
  await compress(publicPath);
  await rm(join(root, 'bundle'), { recursive: true, force: true });
  await rename(staged, join(root, 'bundle'));
} finally {
  await rm(staged, { recursive: true, force: true });
}
