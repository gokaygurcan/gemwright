import { spawn } from 'node:child_process';

export function runCommand(
  args: string[],
  cwd = process.cwd()
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim() || (signal ? `Terminated by ${signal}` : '')
      })
    );
  });
}

export async function command(args: string[], cwd: string): Promise<string> {
  const { code, stdout, stderr } = await runCommand(args, cwd);
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ''} failed: ${stderr || stdout}`);
  return stdout;
}

export async function isAvailable(executable: string): Promise<boolean> {
  try {
    return (await runCommand([executable, '--version'])).code === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function attachedCommand(args: string[], cwd = process.cwd()): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} ${args[1] ?? ''} exited with code ${code ?? 1}.`));
    });
  });
}
