import { mkdir, rm } from 'node:fs/promises';

import type { EmulatorSource } from '../config';
import { command } from '../process';

export async function resolveSource(
  source: Pick<EmulatorSource, 'repository' | 'ref'>,
  label: string,
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<EmulatorSource> {
  const repository = source.repository.replace('https://github.com/', '').replace(/\.git$/, '');
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/commits/${source.ref}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gemwright' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const result = (await response.json()) as { sha?: string };
    if (!result || typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.sha))
      throw new Error('GitHub returned an invalid commit revision');
    return { repository: source.repository, ref: source.ref, revision: result.sha };
  } catch (error) {
    throw new Error(
      `Could not resolve the latest ${label} ${source.ref} revision. Check your connection and retry. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function checkoutSource(directory: string, source: EmulatorSource) {
  await mkdir(directory, { recursive: true });
  await command(['git', 'init', '--quiet'], directory);
  await command(['git', 'fetch', '--quiet', '--depth', '1', source.repository, source.revision], directory);
  await command(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], directory);
}

export async function removeSourceHistory(directory: string) {
  await rm(`${directory}/.git`, { recursive: true, force: true });
}
