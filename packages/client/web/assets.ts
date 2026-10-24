import type { GameFile } from '../files';
import type { FileSystem } from './types';

const hash = async (file: Blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

export async function prepareAssets(
  files: GameFile[],
  status: (message: string, completed: number, total: number) => void
) {
  const root = await navigator.storage.getDirectory();
  const cache = await root.getDirectoryHandle('gemwright-assets', { create: true });
  await navigator.storage.persist();
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  let completed = 0;
  for (const entry of files) {
    status(`Checking ${entry.path}`, completed, total);
    let valid = false;
    try {
      const file = await (await cache.getFileHandle(entry.sha256)).getFile();
      valid = file.size === entry.bytes && (await hash(file)) === entry.sha256;
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    if (!valid) {
      status(`Downloading ${entry.path}`, completed, total);
      const url = `/gamefiles/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(900000) });
      if (!response.ok || !response.body)
        throw new Error(`Could not download ${entry.path} (HTTP ${response.status}).`);
      const handle = await cache.getFileHandle(entry.sha256, { create: true });
      const writer = await handle.createWritable();
      let downloaded = 0;
      await response.body
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              downloaded += chunk.length;
              if (downloaded > entry.bytes) throw new Error(`Unexpected file size for ${entry.path}.`);
              status(`Downloading ${entry.path}`, completed + downloaded, total);
              controller.enqueue(chunk);
            }
          })
        )
        .pipeTo(writer);
      const file = await handle.getFile();
      if (file.size !== entry.bytes || (await hash(file)) !== entry.sha256) {
        await cache.removeEntry(entry.sha256);
        throw new Error(`Integrity check failed for ${entry.path}. Reload to retry.`);
      }
    }
    completed += entry.bytes;
    status(`Prepared ${entry.path}`, completed, total);
  }
  // Only remove obsolete asset blobs after the complete current set has passed validation.
  for await (const [name] of cache.entries()) {
    if (!files.some((file) => file.sha256 === name)) await cache.removeEntry(name);
  }
  return async (fs: FileSystem) => {
    fs.mkdirTree('/uo');
    let mounted = 0;
    for (const entry of files) {
      status(`Loading ${entry.path}`, mounted, total);
      const path = `/uo/${entry.path.toLowerCase()}`;
      fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      const stream = fs.open(path, 'w');
      try {
        fs.ftruncate(stream.fd, entry.bytes);
        const file = await (await cache.getFileHandle(entry.sha256)).getFile();
        for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
          const bytes = new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer());
          fs.write(stream, bytes, 0, bytes.length, offset);
        }
      } finally {
        fs.close(stream);
      }
      mounted += entry.bytes;
    }
  };
}

export async function restoreProfiles(fs: FileSystem) {
  fs.mkdirTree('/Data');
  if (!fs.filesystems.IDBFS) throw new Error('The WASM runtime does not include profile storage (IDBFS).');
  fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, '/Data');
  await new Promise<void>((resolve, reject) => fs.syncfs(true, (error) => (error ? reject(error) : resolve())));
}
