export interface GameFile {
  path: string;
  bytes: number;
  sha256: string;
}

export function parseManifest(value: unknown): GameFile[] {
  const entries = (value as { files?: unknown })?.files;
  if (!Array.isArray(entries) || !entries.length) throw new Error('The game-file manifest is empty or invalid.');
  const paths = new Set<string>();
  return entries.map((file: GameFile) => {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !/^[a-zA-Z0-9_./ -]+$/.test(file.path) ||
      file.path.split('/').some((part) => !part || part.startsWith('.')) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('The game-file manifest contains an invalid entry.');
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate game file: ${file.path}`);
    paths.add(key);
    return file;
  });
}

export function runtimeFiles(files: GameFile[]): GameFile[] {
  // The vendored StringDictionaryLoader passes the archive length to managed zlib,
  // so its checksum check reads beyond the entry. This optional dictionary can be absent.
  const selected = files.filter(
    (file) => !/\.(mp3|mid|png)$/i.test(file.path) && file.path.toLowerCase() !== 'string_dictionary.uop'
  );
  if (selected.some((file) => file.bytes > 0x7fffffff))
    throw new Error("A game file exceeds the runtime's 2 GiB per-file limit.");
  return selected;
}
