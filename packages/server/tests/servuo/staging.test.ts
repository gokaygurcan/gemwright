import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('client packaging excludes unrelated files and duplicate x variants', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { packageClientFiles } = await import('../../src/emulators/servuo/staging');
  const { command } = await import('@gemwright/deployment/process');
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-client-package-'));
  folders.push(directory);
  const source = join(directory, 'files');
  await mkdir(source);
  await mkdir(join(directory, '.gemwright'));
  for (const name of ['tiledata.mul', 'map0LegacyMUL.uop', 'map0xLegacyMUL.uop', 'artLegacyMUL.uop']) {
    await writeFile(join(source, name), 'test');
  }
  const packaged = await packageClientFiles(directory, source);
  expect(packaged.bytes).toBe(8);
  const names = await command(['tar', '-tzf', packaged.archive], directory);
  expect(names).toContain('tiledata.mul');
  expect(names).toContain('map0LegacyMUL.uop');
  expect(names).not.toContain('map0x');
  expect(names).not.toContain('artLegacy');
});

test('the staged server reads the deployment game files and loads the scripts the image build compiled', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { applyDeploymentConfig } = await import('../../src/emulators/servuo/staging');
  const server = await mkdtemp(join(tmpdir(), 'gemwright-servuo-config-'));
  folders.push(server);
  await mkdir(join(server, 'Config'));
  await writeFile(join(server, 'Config/DataPath.cfg'), 'CustomPath=@C:\\UO\n');
  await writeFile(join(server, 'Config/Compiler.cfg'), '# Forces scripts to be compiled at runtime.\nDynamic=True');
  await applyDeploymentConfig(server);
  expect(await readFile(join(server, 'Config/DataPath.cfg'), 'utf8')).toContain('CustomPath=data/client');
  expect(await readFile(join(server, 'Config/Compiler.cfg'), 'utf8')).toContain('Dynamic=False');
  await rm(join(server, 'Config/Compiler.cfg'));
  await applyDeploymentConfig(server);
  expect(await readFile(join(server, 'Config/Compiler.cfg'), 'utf8')).toContain('Dynamic=False');
});
