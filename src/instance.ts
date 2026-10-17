import { appendFile, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { configFilename, type ShardConfig } from './config';
import { command, runCommand } from './process';

export type InstanceFiles = Record<string, string | Uint8Array>;

export async function existingAncestor(directory: string): Promise<string> {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(directory);
    if (parent === directory) throw error;
    return existingAncestor(parent);
  }
}

export async function gitStatus(directory: string): Promise<{ available: boolean; insideRepository: boolean }> {
  try {
    const result = await runCommand(['git', '-C', await existingAncestor(directory), 'rev-parse', '--show-toplevel']);
    return { available: true, insideRepository: result.code === 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, insideRepository: false };
    throw error;
  }
}

export async function ensureNewConfig(directory: string): Promise<void> {
  try {
    await stat(join(directory, configFilename));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${configFilename} already exists in ${directory}. Refusing to overwrite it.`);
}

export async function saveInstance(
  directory: string,
  config: ShardConfig,
  initializeGit: boolean,
  files: InstanceFiles = {}
): Promise<void> {
  const output: InstanceFiles = { ...files, [configFilename]: `${JSON.stringify(config, null, 2)}\n` };
  if (output['.gitignore'] !== undefined && typeof output['.gitignore'] !== 'string')
    throw new Error('.gitignore must contain text.');
  for (const filename of Object.keys(output)) {
    if (isAbsolute(filename) || filename.split(/[\\/]/).some((part) => part === '..' || part === '')) {
      throw new Error(`Invalid instance file path: ${filename}`);
    }
    const parts = filename.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      try {
        const parent = await lstat(join(directory, ...parts.slice(0, depth)));
        if (!parent.isDirectory())
          throw new Error(`Refusing to write through a non-directory: ${parts.slice(0, depth).join('/')}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      const info = await lstat(join(directory, filename));
      if (filename === '.gitignore' && info.isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Refusing to overwrite ${join(directory, filename)}.`);
  }
  await mkdir(directory, { recursive: true });
  for (const [filename, content] of Object.entries(output)) {
    await mkdir(dirname(join(directory, filename)), { recursive: true });
    if (filename === '.gitignore') {
      if (typeof content !== 'string') throw new Error('.gitignore must contain text.');
      let existing = '';
      try {
        existing = await readFile(join(directory, filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const present = new Set(existing.split(/\r?\n/));
      const missing = content.split('\n').filter((line) => line && !present.has(line));
      if (missing.length)
        await appendFile(
          join(directory, filename),
          `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
        );
    } else {
      await writeFile(join(directory, filename), content, {
        flag: 'wx',
        mode: ['Saves/Accounts/accounts.xml', 'accounts/sphereaccu.scp'].includes(filename) ? 0o600 : 0o644
      });
    }
  }
  if (initializeGit) {
    try {
      await command(['git', 'init', directory], directory);
    } catch (error) {
      throw new Error(
        `Saved ${configFilename}, but Git initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
