import { readFile } from 'node:fs/promises';

export async function readJson<T>(path: string): Promise<T | undefined> {
  return readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as T,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    }
  );
}
