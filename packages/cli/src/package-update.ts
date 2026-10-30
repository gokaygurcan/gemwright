import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertCompatible,
  type Component,
  compareVersions,
  components,
  packageNames,
  stableVersion
} from '@gemwright/common/config/compatibility';
import { loadShard } from '@gemwright/server/config';

import { assetPath } from './assets';

export async function packageVersions(component: Component): Promise<string[]> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageNames[component])}`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok)
    throw new Error(
      `Cannot discover ${packageNames[component]} versions (npm HTTP ${response.status}). No configuration changed.`
    );
  const metadata = await response.json();
  return Object.keys(metadata.versions ?? {}).filter((version) => stableVersion(version));
}
export async function updatePackages(
  options: { component?: Component; version?: string },
  directory = process.cwd(),
  discover: (component: Component) => Promise<string[]> = packageVersions,
  progress: (message: string) => void = console.log
): Promise<void> {
  if (options.version && !options.component)
    throw new Error('Select exactly one of --server, --client or --ai with --package-version.');
  const config = await loadShard(directory);
  const baseline = JSON.parse(await readFile(assetPath('package.json'), 'utf8')).version;
  for (const component of options.component ? [options.component] : components) {
    if (options.version) assertCompatible(config.schemaVersion ?? 1, component, options.version);
    const versions = await discover(component);
    if (options.version) {
      if (!versions.includes(options.version))
        throw new Error(`${packageNames[component]}@${options.version} is not published. No configuration changed.`);
      const path = join(directory, 'gemwright.json');
      // Preserve unrelated settings and credentials; discovery never writes to this file.
      const original = JSON.parse(await readFile(path, 'utf8'));
      original.packages = { ...original.packages, [component]: options.version };
      await writeFile(`${path}.tmp`, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      progress(
        `Selected ${packageNames[component]}@${options.version}. Apply explicitly: gemwright deploy --${component}`
      );
      return;
    }
    const supported = versions
      .filter((version) => {
        try {
          assertCompatible(config.schemaVersion ?? 1, component, version);
          return true;
        } catch {
          return false;
        }
      })
      .sort(compareVersions);
    const latest = supported.at(-1);
    const current = config.packages?.[component] ?? baseline;
    if (latest && compareVersions(latest, current) > 0)
      progress(
        `Update available: ${packageNames[component]} ${current} → ${latest}\nRun: gemwright update --${component} --package-version ${latest}\nThen: gemwright deploy --${component}`
      );
    else progress(`${packageNames[component]}: no newer compatible published version (selected ${current}).`);
  }
}
