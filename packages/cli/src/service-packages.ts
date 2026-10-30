import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertCompatible, type Component, packageNames } from '@gemwright/common/config/compatibility';
import type { ShardConfig } from '@gemwright/common/config/types';
import { command } from '@gemwright/deployment/process';

// npm verifies registry integrity; scripts are disabled and extraction stays in a disposable directory.
export async function withServicePackages<T>(
  config: ShardConfig,
  selected: Component[],
  use: (paths: Partial<Record<Component, string>>) => Promise<T>,
  run = command
): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), 'gemwright-packages-'));
  const paths: Partial<Record<Component, string>> = {};
  try {
    for (const component of selected) {
      const version = config.packages?.[component];
      if (!version) continue;
      assertCompatible(config.schemaVersion ?? 1, component, version);
      const destination = join(temporary, component);
      await mkdir(destination);
      const spec = `${packageNames[component]}@${version}`;
      const output = JSON.parse(
        await run(['npm', 'pack', spec, '--ignore-scripts', '--json', '--pack-destination', destination], temporary)
      );
      const packed = Array.isArray(output)
        ? output
        : (Object.values(output) as { name: string; version: string; filename: string }[]);
      if (packed.length !== 1 || packed[0].name !== packageNames[component] || packed[0].version !== version)
        throw new Error(`Unexpected npm artifact for ${spec}.`);
      const filename = packed[0].filename;
      if (typeof filename !== 'string' || !/^[A-Za-z0-9_.-]+\.tgz$/.test(filename))
        throw new Error('Invalid npm artifact filename.');
      const tarball = join(destination, filename);
      const entries = (await run(['tar', '-tzf', tarball], temporary)).split('\n').filter(Boolean);
      if (
        !entries.length ||
        entries.some((entry) => !entry.startsWith('package/') || entry.includes('..') || entry.includes('\\'))
      )
        throw new Error(`Unsafe paths in ${spec}.`);
      // Reject archive links before extraction; service artifacts contain regular files/directories only.
      const listing = await run(['tar', '-tvzf', tarball], temporary);
      if (listing.split('\n').some((entry) => entry && !['-', 'd'].includes(entry[0] ?? '')))
        throw new Error(`Links or special files are not supported in ${spec}.`);
      await run(['tar', '-xzf', tarball, '-C', destination], temporary);
      const source = join(destination, 'package');
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      if (
        manifest.name !== packageNames[component] ||
        manifest.version !== version ||
        manifest.gemwright?.schemaVersion !== 1
      )
        throw new Error(
          `Package identity or configuration schema mismatch in ${spec}. Update the CLI: npm i -g gemwright@latest`
        );
      for (const path of component === 'server'
        ? ['dist/staging.js', 'templates', 'patches']
        : ['Dockerfile', component === 'ai' ? 'dist/serve.js' : 'bundle/server.js'])
        await stat(join(source, path));
      paths[component] = source;
    }
    return await use(paths);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
