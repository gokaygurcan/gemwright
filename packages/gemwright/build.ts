import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { build as buildClient } from '@gemwright/client/build';

import { images, stageManifests, workspacePath } from './src/assets';

// The published package: the CLI bundled into dist/index.js (the workspace packages it imports
// inlined, only npm dependencies left external), the files each deployed image is built from in
// workspace/, and the repository's README, license and logo.
const root = import.meta.dir;
await buildClient();
const result = await Bun.build({
  entrypoints: [join(root, 'src/index.ts')],
  outdir: join(root, 'dist'),
  naming: 'index.js',
  target: 'node',
  format: 'esm',
  external: ['@clack/prompts', 'chalk']
});
if (!result.success) throw new AggregateError(result.logs, 'The CLI did not build');

const workspace = join(root, 'workspace');
await rm(workspace, { recursive: true, force: true });
await mkdir(workspace);
await stageManifests(workspace);
for (const [image, { root: files, packages }] of Object.entries(images)) {
  for (const path of files)
    await cp(workspacePath(`packages/${image}/${path}`), join(workspace, 'packages', image, path));
  for (const [name, paths] of Object.entries(packages))
    for (const path of paths)
      await cp(workspacePath(`packages/${name}/${path}`), join(workspace, 'packages', name, path), { recursive: true });
}
for (const path of ['README.md', 'LICENSE', '.github/small-forge.png'])
  await cp(workspacePath(path), join(root, path), { recursive: true });
console.log('Built dist/index.js and workspace/.');
