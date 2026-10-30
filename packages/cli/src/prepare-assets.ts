import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { images, workspacePath } from './assets';

const root = join(import.meta.dirname, '..');
for (const directory of ['templates', 'patches']) {
  await rm(join(root, directory), { recursive: true, force: true });
  await cp(workspacePath(`packages/server/${directory}`), join(root, directory), { recursive: true });
}
const workspace = join(root, 'workspace');
await rm(workspace, { recursive: true, force: true });
await mkdir(workspace);
for (const [image, { root: files, files: content }] of Object.entries(images)) {
  for (const path of ['package.json', ...files, ...content])
    await cp(workspacePath(`packages/${image}/${path}`), join(workspace, 'packages', image, path), {
      recursive: true,
      filter: (source) => basename(source) !== '.DS_Store'
    });
}
for (const path of ['LICENSE', '.github/small-forge.png'])
  await cp(workspacePath(path), join(root, path), { recursive: true });
