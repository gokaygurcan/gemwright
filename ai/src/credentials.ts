import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ascii } from './protocol/packets';
import type { Credentials } from './protocol/session';
import type { ResidentStore } from './store';

// A resident's game account lives in the resident database (credentials table), so a population's
// container carries everything in one private file. Accounts from the earlier per-resident files
// (`<data>/credentials/<id>.json`, mode 0600) are imported on first use; the files stay untouched
// and can be removed once every resident has run.
export async function residentCredentials(
  store: ResidentStore,
  residentId: string,
  allowCreate: boolean,
  legacyDirectory?: string
): Promise<Credentials> {
  if (!/^[a-f0-9-]{36}$/.test(residentId)) throw new Error('Invalid resident credential reference');
  const stored = store.credentials(residentId) ?? (await importLegacy(store, residentId, legacyDirectory));
  if (stored) return checked(stored);
  if (!allowCreate)
    throw new Error('Resident credentials are missing; account provisioning must be explicitly enabled');
  return checked(
    store.storeCredentials(residentId, {
      username: `gw${residentId.replaceAll('-', '').slice(0, 20)}`,
      password: randomBytes(12).toString('hex')
    })
  );
}

function checked(c: { username: string; password: string }): Credentials {
  ascii(c.username, 30, 'Account name');
  ascii(c.password, 30, 'Password');
  return { username: c.username, password: c.password };
}

async function importLegacy(store: ResidentStore, residentId: string, directory?: string) {
  if (!directory) return null;
  const path = join(directory, `${residentId}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('Credential file must be private (mode 0600) and must not be a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Resident credential file is invalid');
  }
  const c = (parsed ?? {}) as Record<string, unknown>;
  if (typeof c.username !== 'string' || typeof c.password !== 'string')
    throw new Error('Resident credential fields are missing');
  return store.storeCredentials(residentId, { username: c.username, password: c.password });
}
