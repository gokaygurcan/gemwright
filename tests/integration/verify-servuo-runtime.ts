import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(err || out);
  return out.trim();
}

const name = `gemwright-recovery-${randomUUID()}`;
const tests = fileURLToPath(new URL('../servuo', import.meta.url));
try {
  await docker([
    'run',
    '--name',
    name,
    '--restart',
    'on-failure:2',
    '-d',
    '--mount',
    `type=bind,source=${tests},target=/tests,readonly`,
    '--entrypoint',
    '/bin/sh',
    process.argv[2] ?? 'gemwright-crash-check:local',
    '-ec',
    `
mkdir -p /tmp/check-bin /results
mcs -r:/opt/servuo/ServUO.exe -r:/opt/servuo/Scripts.dll -out:/tmp/RuntimeTests.exe /tests/RuntimeTests.cs
printf '#!/bin/sh\nexec /usr/bin/mono /tmp/RuntimeTests.exe "$@"\n' > /tmp/check-bin/mono
chmod +x /tmp/check-bin/mono
export PATH=/tmp/check-bin:$PATH MONO_PATH=/opt/servuo GEMWRIGHT_TEST_STATE=/results
cd /opt/servuo
exec /opt/gemwright/run-server.sh --public 127.0.0.1:2593 --railway-proxy
`
  ]);
  let completed = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const [state] = JSON.parse(await docker(['inspect', name]));
    if (state.State.Status === 'exited') {
      const logs = await docker(['logs', name]);
      console.log(logs);
      if (
        state.State.ExitCode !== 0 ||
        state.RestartCount !== 1 ||
        !logs.includes('Native compression round trip passed.') ||
        !logs.includes('Packed gump layout and text compression passed.') ||
        !logs.includes('Crash: Generating report...done') ||
        !logs.includes('Crash: Exiting; restart is managed by the host.') ||
        logs.includes('Crash: Restarting...') ||
        !logs.includes('Recovery preserved saved state.')
      )
        throw new Error(`Recovery check failed: exit=${state.State.ExitCode}, restarts=${state.RestartCount}`);
      completed = true;
      break;
    }
    await Bun.sleep(1000);
  }
  if (!completed) throw new Error('Recovery check timed out');
  console.log('Compression, fatal crash exit, host restart and saved-state preservation passed.');
} finally {
  await docker(['rm', '-f', name]);
}
