import { setTimeout as sleep } from 'node:timers/promises';

import { command, runCommand } from '../process';

export async function railway(args: string[], directory: string): Promise<string> {
  const { code, stdout, stderr } = await runCommand(['railway', ...args], directory);
  // The whole message: Railway's reason can come before a closing hint line.
  if (code !== 0)
    throw new Error(
      stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('> Select'))
        .join(' ') ||
        stdout ||
        `railway ${args[0]} failed`
    );
  return stdout;
}

export async function waitForReadiness(
  flags: string[],
  check: string,
  directory: string,
  label: string
): Promise<void> {
  let reason = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await command(['railway', 'ssh', ...flags, check], directory);
      return;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      await sleep(2000);
    }
  }
  throw new Error(
    `${label} readiness timed out: ${reason}. Inspect: railway logs ${flags.join(' ')}. Correct the cause and rerun the same selected component.`
  );
}
