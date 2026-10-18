import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { assetPath } from './assets';

const day = 24 * 60 * 60 * 1000;

function versionParts(version: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return;
  const parts = version.split('.').map(Number);
  if (parts.every(Number.isSafeInteger)) return parts;
}

export function newerVersion(current: string, latest: string): boolean {
  const installed = versionParts(current);
  const available = versionParts(latest);
  if (!installed || !available) return false;
  for (let index = 0; index < 3; index++) {
    const difference = available[index]! - installed[index]!;
    if (difference) return difference > 0;
  }
  return false;
}

export async function checkForUpdate(options: {
  current: string;
  cachePath: string;
  now?: number;
  fetchLatest?: () => Promise<string>;
}): Promise<string | undefined> {
  try {
    const now = options.now ?? Date.now();
    let latest: string | undefined;
    let cached = false;
    try {
      const cache = JSON.parse(await readFile(options.cachePath, 'utf8'));
      cached = typeof cache.checkedAt === 'number' && cache.checkedAt <= now && now - cache.checkedAt < day;
      if (cached && typeof cache.latest === 'string') latest = cache.latest;
    } catch {}
    if (!cached) {
      try {
        latest = await (
          options.fetchLatest ??
          (async () => {
            const response = await fetch('https://registry.npmjs.org/gemwright/latest', {
              signal: AbortSignal.timeout(1000)
            });
            if (!response.ok) throw new Error('Update check failed');
            const metadata = await response.json();
            return metadata.version;
          })
        )();
      } catch {}
      try {
        await mkdir(dirname(options.cachePath), { recursive: true });
        await writeFile(options.cachePath, JSON.stringify({ checkedAt: now, latest }));
      } catch {}
    }
    if (typeof latest === 'string' && newerVersion(options.current, latest)) {
      return `Update available: gemwright ${options.current} → ${latest}\nRun: npm i -g gemwright@latest`;
    }
  } catch {}
}

export async function updateNotice(): Promise<string | undefined> {
  if (!process.stderr.isTTY || !process.stdout.isTTY || process.env.CI || process.env.NO_UPDATE_NOTIFIER) return;
  try {
    const { version } = JSON.parse(await readFile(assetPath('package.json'), 'utf8'));
    const cacheRoot = process.env.XDG_CACHE_HOME;
    return await checkForUpdate({
      current: version,
      cachePath: join(
        cacheRoot && isAbsolute(cacheRoot) ? cacheRoot : join(homedir(), '.cache'),
        'gemwright',
        'update.json'
      )
    });
  } catch {}
}
