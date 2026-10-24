import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyServuoCompatibility, resolveLatestServuoSource, servuoSource } from '../../src/emulators/servuo/source';

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${args.join(' ')}`);
}

const directory = await mkdtemp(join(tmpdir(), 'gemwright-servuo-verify-'));
try {
  const source = await resolveLatestServuoSource();
  console.log(`Verifying latest ${source.ref} revision ${source.revision}`);
  await run(['git', 'init', '--quiet'], directory);
  await run(['git', 'fetch', '--quiet', '--depth', '1', servuoSource.repository, source.revision], directory);
  await run(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], directory);
  if ((await applyServuoCompatibility(directory, source.revision)) !== 'applied')
    throw new Error('Fresh patch was not applied');
  if ((await applyServuoCompatibility(directory, source.revision)) !== 'already-applied')
    throw new Error('Patch is not idempotent');
  await run(['dotnet', 'build', 'ServUO.sln', '-c', 'Release', '--nologo', '-v', 'quiet'], directory);

  const harness = join(directory, 'hosting-tests');
  await mkdir(harness);
  await copyFile(join(directory, 'Server/Persistence/FileOperations.cs'), join(harness, 'FileOperations.cs'));
  await copyFile(join(directory, 'Server', 'HostingOptions.cs'), join(harness, 'HostingOptions.cs'));
  await copyFile(
    fileURLToPath(new URL('./servuo/HostingOptionsTests.cs', import.meta.url)),
    join(harness, 'Program.cs')
  );
  await writeFile(
    join(harness, 'HostingTests.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><EnableDefaultCompileItems>true</EnableDefaultCompileItems></PropertyGroup>
</Project>\n`
  );
  await run(['dotnet', 'run', '--project', 'HostingTests.csproj', '-c', 'Release', '--nologo'], harness);
  console.log('Pinned ServUO patch application, repeat application, compilation and hosting option checks passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
