import { runCommand } from '../process';

function git(directory: string, args: string[]) {
  return runCommand(['git', '-C', directory, ...args]);
}

export async function applyCompatibility(
  directory: string,
  expectedRevision: string,
  patch: string,
  emulator: string
): Promise<'applied' | 'already-applied'> {
  if (!/^[a-f0-9]{40}$/.test(expectedRevision))
    throw new Error(`Invalid recorded ${emulator} revision. No patch was applied.`);
  const revision = await git(directory, ['rev-parse', 'HEAD']);
  if (revision.code !== 0 || revision.stdout !== expectedRevision) {
    throw new Error(`${emulator} compatibility requires revision ${expectedRevision}. No patch was applied.`);
  }
  const reverse = await git(directory, ['apply', '--reverse', '--check', patch]);
  if (reverse.code === 0) return 'already-applied';
  const check = await git(directory, ['apply', '--check', patch]);
  if (check.code !== 0) {
    throw new Error(
      `${emulator} compatibility patch does not apply cleanly to recorded revision ${expectedRevision}. No patch was applied.\n${check.stderr}`
    );
  }
  const result = await git(directory, ['apply', patch]);
  if (result.code !== 0) throw new Error(`Failed to apply ${emulator} compatibility patch: ${result.stderr}`);
  return 'applied';
}
