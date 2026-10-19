import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { command } from '../../src/process';

// Fixture: ServUO pub57 d76bf4443cf76d081ddaf8f57c87ff33749256af, before Gemwright's patch.
test.skipIf(!Bun.which('dotnet'))(
  'saving serializes scripts sequentially and defers seasonal entity generation',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemwright-save-strategy-'));
    const dotnet = (args: string[]) =>
      command(
        [
          'env',
          `DOTNET_CLI_HOME=${directory}`,
          'DOTNET_CLI_TELEMETRY_OPTOUT=1',
          'DOTNET_GENERATE_ASPNET_CERTIFICATE=false',
          'dotnet',
          ...args
        ],
        directory
      );
    try {
      await mkdir(join(directory, 'Server/Persistence'), { recursive: true });
      // Upstream core files use CRLF; Git may normalize the stored fixture on checkout.
      await writeFile(
        join(directory, 'Server/Persistence/SaveStrategy.cs'),
        (await readFile(fileURLToPath(new URL('./fixtures/SaveStrategy.cs', import.meta.url)), 'utf8')).replace(
          /\r?\n/g,
          '\r\n'
        )
      );
      const seasonalPath = 'Scripts/Services/Seasonal Events/TreasuresOfKhaldun/Generate.cs';
      await mkdir(join(directory, 'Scripts/Services/Seasonal Events/TreasuresOfKhaldun'), { recursive: true });
      await cp(
        fileURLToPath(new URL('./fixtures/Seasonal/Generate.cs', import.meta.url)),
        join(directory, seasonalPath)
      );
      const patch = fileURLToPath(new URL('../../patches/servuo-pub57-hosting.patch', import.meta.url));
      await command(
        ['git', 'apply', '--include=Server/Persistence/SaveStrategy.cs', `--include=${seasonalPath}`, patch],
        directory
      );
      const seasonal = await readFile(join(directory, seasonalPath), 'utf8');
      const handlerStart = seasonal.indexOf('private static void OnWorldSave(');
      const handlerEnd = seasonal.indexOf('public static void CheckEnabled(', handlerStart);
      if (handlerStart < 0 || handlerEnd < 0) throw new Error('Seasonal save handler fixture changed');
      const handler = seasonal.slice(handlerStart, handlerEnd);
      // Compile the real callback without the quest's unrelated map/content dependencies.
      await rm(join(directory, 'Scripts'), { recursive: true });
      const version = await dotnet(['--version']);
      const major = Number.parseInt(version, 10);
      if (!Number.isSafeInteger(major) || major < 8)
        throw new Error('Save strategy regression requires .NET SDK 8 or newer');
      await writeFile(
        join(directory, 'Regression.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${major}.0</TargetFramework></PropertyGroup></Project>`
      );
      await writeFile(
        join(directory, 'NuGet.Config'),
        '<configuration><packageSources><clear /></packageSources></configuration>'
      );
      await writeFile(
        join(directory, 'Program.cs'),
        `
using System;
using Server;
foreach (int count in new[] { 1, 2, 8, 16, 17, 48, 64, 128 })
{
    Core.ProcessorCount = count;
    SaveStrategy strategy = SaveStrategy.Acquire();
    if (strategy.GetType() != typeof(StandardSaveStrategy))
        throw new Exception("Unsafe serialization selected with " + count + " CPUs");
}
Console.WriteLine("All CPU profiles serialize scripts sequentially.");
SeasonalProbe.Verify();
public static class SeasonalProbe
{
    private static bool saving;
    private static int executions;
    ${handler}
    private static void CheckEnabled(bool timed)
    {
        if (saving) throw new Exception("Seasonal content mutated during world save");
        executions++;
    }
    public static void Verify()
    {
        saving = true;
        OnWorldSave(new WorldSaveEventArgs());
        if (executions != 0 || Timer.Pending.Count != 1)
            throw new Exception("Seasonal check must be deferred exactly once");
        saving = false;
        Timer.Pending.Dequeue()();
        if (executions != 1) throw new Exception("Seasonal check did not run after saving");
        Console.WriteLine("Seasonal content runs after world saving completes.");
    }
}
namespace Server
{
    public class WorldSaveEventArgs {}
    public static class Timer
    {
        public static readonly System.Collections.Generic.Queue<Action> Pending = new System.Collections.Generic.Queue<Action>();
        public static void DelayCall(TimeSpan delay, Action callback) { Pending.Enqueue(callback); }
    }
    public static class Core
    {
        public static int ProcessorCount;
        public static bool MultiProcessor => ProcessorCount > 1;
    }
    public class SaveMetrics {}
    public class StandardSaveStrategy : SaveStrategy
    {
        public override string Name => "Standard";
        public override void Save(SaveMetrics metrics, bool background) {}
        public override void ProcessDecay() {}
    }
    public class DualSaveStrategy : StandardSaveStrategy {}
    public class DynamicSaveStrategy : StandardSaveStrategy {}
    public class ParallelSaveStrategy : StandardSaveStrategy
    {
        public ParallelSaveStrategy(int count) {}
    }
}
`
      );
      for (const constant of ['ServUO', 'DynamicSaveStrategy']) {
        await dotnet([
          'build',
          'Regression.csproj',
          '--nologo',
          '-v',
          'quiet',
          '-nr:false',
          '-p:UseSharedCompilation=false',
          `-p:DefineConstants=${constant}`
        ]);
        const output = await dotnet([join(directory, `bin/Debug/net${major}.0/Regression.dll`)]);
        expect(output).toContain('All CPU profiles serialize scripts sequentially.');
        expect(output).toContain('Seasonal content runs after world saving completes.');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000
);
