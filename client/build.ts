import { createReadStream, createWriteStream } from 'node:fs';
import { cp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { constants, createBrotliCompress } from 'node:zlib';

async function compressFiles(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await compressFiles(path);
    else if (entry.isFile() && /\.(wasm|m?js|json|css|html|txt)$/i.test(entry.name)) {
      const temporary = `${path}.br.tmp`;
      try {
        await pipeline(
          createReadStream(path),
          createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
          createWriteStream(temporary)
        );
        await rename(temporary, `${path}.br`);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
  }
}

const root = dirname(fileURLToPath(import.meta.url));

export async function build() {
  const staged = join(root, 'bundle.next');
  await rm(staged, { recursive: true, force: true });
  try {
    const publicPath = join(staged, 'public');
    await cp(join(root, 'runtime'), publicPath, { recursive: true });
    const result = await Bun.build({
      entrypoints: [join(root, 'web/main.ts')],
      outdir: publicPath,
      target: 'browser',
      minify: true
    });
    if (!result.success) throw new AggregateError(result.logs, 'Browser host build failed.');
    await cp(join(root, 'web'), publicPath, { recursive: true, filter: (path) => !path.endsWith('.ts') });
    const service = await Bun.build({
      entrypoints: [join(root, 'server.ts')],
      outdir: staged,
      target: 'bun',
      minify: true
    });
    if (!service.success) throw new AggregateError(service.logs, 'Client service build failed.');
    await compressFiles(publicPath);
    await rm(join(root, 'bundle'), { recursive: true, force: true });
    await rename(staged, join(root, 'bundle'));
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  console.log('ClassicUO bundle prepared in client/bundle/.');
}
if (import.meta.main) await build();
