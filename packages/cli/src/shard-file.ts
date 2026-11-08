import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateSchema } from '@gemwright/common/config/compatibility';

// Unrelated settings stay as written; the result is validated before it replaces the file.
type ShardFile = Record<string, unknown> & { target?: string; vps?: Record<string, unknown> };

export async function updateShardFile(directory: string, change: (config: ShardFile) => void) {
  const path = join(directory, 'gemwright.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  change(config);
  validateSchema(config);
  await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
