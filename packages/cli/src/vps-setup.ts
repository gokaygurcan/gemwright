import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { attachedCommand, command } from '@gemwright/deployment/process';
import { sshCommand } from '@gemwright/deployment/target';

import * as prompts from '@clack/prompts';

import { validateSshDestination } from './deploy-options';
import { answer, Cancelled } from './prompts';
import { updateShardFile } from './shard-file';
import { shellQuote } from './shell';
import { validateVpsOptions } from './vps-deploy';
import { hostProblems } from './vps-preflight';

const DEPLOY_USER = 'gemwright';

export interface SetupOptions {
  ssh?: string;
  sshPort?: number;
  publicHost?: string;
  client?: boolean;
  yes?: boolean;
}

export interface ServerInspection {
  user: string;
  ubuntu: boolean;
  compose: boolean;
  access: boolean;
  memoryKib?: number;
}

export interface SetupStep {
  label: string;
  script: string;
}

export const inspectionScript = `id -un
if [ -r /etc/os-release ] && grep -q '^ID=ubuntu$' /etc/os-release; then echo ubuntu; else echo other; fi
if docker compose version >/dev/null 2>&1; then echo compose; else echo none; fi
if docker info >/dev/null 2>&1; then echo access; else echo none; fi
awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0`;

export function parseInspection(output: string): ServerInspection {
  const [user = '', os, compose, access, memory] = output.split('\n');
  return {
    user,
    ubuntu: os === 'ubuntu',
    compose: compose === 'compose',
    access: access === 'access',
    ...(Number(memory) ? { memoryKib: Number(memory) } : {})
  };
}

export function setupSteps(server: ServerInspection, options: { port: number; client?: boolean }): SetupStep[] {
  const root = server.user === 'root';
  const sudo = root ? '' : 'sudo ';
  const user = root ? DEPLOY_USER : server.user;
  const steps: SetupStep[] = [];
  if (root)
    steps.push({
      label: `Create the non-root deploy user ${DEPLOY_USER} with this login's SSH keys`,
      script: `id ${DEPLOY_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${DEPLOY_USER}
install -d -m 700 -o ${DEPLOY_USER} -g ${DEPLOY_USER} /home/${DEPLOY_USER}/.ssh
install -m 600 -o ${DEPLOY_USER} -g ${DEPLOY_USER} "$HOME/.ssh/authorized_keys" /home/${DEPLOY_USER}/.ssh/authorized_keys`
    });
  if (!server.compose) {
    if (!server.ubuntu) throw new Error('Automatic server setup supports Ubuntu. Install Docker Compose, then rerun.');
    steps.push({
      label: 'Install Docker and the Compose plugin',
      script: `${sudo}apt-get update
${sudo}apt-get install -y docker.io docker-compose-v2
${sudo}systemctl enable --now docker`
    });
  }
  if (root || !server.access)
    steps.push({
      label: `Add ${user} to the docker group, which is equivalent to root access on this server`,
      script: `${sudo}usermod -aG docker ${shellQuote(user)}`
    });
  const ports = [`${options.port}/tcp`, '2593/tcp', ...(options.client ? ['80/tcp', '443/tcp', '443/udp'] : [])];
  steps.push({
    label: `Allow ${ports.join(', ')} if the ufw firewall is active`,
    script: `if command -v ufw >/dev/null 2>&1 && ${sudo}ufw status | grep -q '^Status: active'; then
${ports.map((port) => `    ${sudo}ufw allow ${port}`).join('\n')}
fi`
  });
  return steps;
}

export async function recordServer(
  directory: string,
  server: { ssh: string; port?: number; publicHost: string }
): Promise<void> {
  await updateShardFile(directory, (config) => {
    const { port: _, ...kept } = config.vps ?? {};
    config.vps = { ...kept, ...server };
  });
}

// The password prompt belongs to sudo on the server, so it never passes through this process.
export async function setupServer(options: SetupOptions, directory = process.cwd()) {
  const shard = existsSync(join(directory, 'gemwright.json'))
    ? JSON.parse(await readFile(join(directory, 'gemwright.json'), 'utf8'))
    : undefined;
  const interactive = !!process.stdin.isTTY && !options.yes;
  const ssh =
    options.ssh ??
    shard?.vps?.ssh ??
    (interactive
      ? answer(
          await prompts.text({ message: 'SSH destination (config alias or user@hostname)', placeholder: 'my-vps' })
        )
      : undefined);
  if (!ssh) throw new Error('Pass --ssh <destination>, or set vps.ssh in gemwright.json.');
  validateSshDestination(ssh);
  const requestedPort: number | undefined = options.sshPort ?? shard?.vps?.port;
  const resolved = new Map(
    (await command([...sshCommand(undefined, requestedPort), '-G', ssh], directory))
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
  );
  const port = requestedPort ?? Number(resolved.get('port') ?? 22);
  const publicHost: string = options.publicHost ?? shard?.vps?.publicHost ?? resolved.get('hostname') ?? '';
  validateVpsOptions({ publicHost });
  const remote = (script: string, destination = ssh) =>
    command([...sshCommand(destination, requestedPort), script], directory);
  const server = parseInspection(await remote(inspectionScript));
  hostProblems(
    { freeKib: Number.POSITIVE_INFINITY, sudo: true, docker: true, memoryKib: server.memoryKib },
    { publicHost },
    true,
    true
  );
  const steps = setupSteps(server, { port, client: options.client });
  console.log(`Setup for ${ssh}:\n${steps.map((step) => `- ${step.label}`).join('\n')}`);
  if (interactive && !answer(await prompts.confirm({ message: 'Make these changes?', initialValue: true })))
    throw new Cancelled();
  if (!interactive && !options.yes) throw new Error('Setup changes the server: rerun with --yes to confirm.');
  await attachedCommand(
    [
      ...sshCommand(ssh, requestedPort, process.stdin.isTTY ? ['-t'] : []),
      `set -eu\n${steps.map((step) => step.script).join('\n')}`
    ],
    directory
  );
  const host = ssh.slice(ssh.indexOf('@') + 1);
  const destination = server.user === 'root' ? `${DEPLOY_USER}@${host}` : ssh;
  const verified = parseInspection(await remote(inspectionScript, destination));
  if (!verified.compose || !verified.access) throw new Error(`Docker is not usable by ${verified.user} after setup.`);
  console.log(`Server ready: ${verified.user} can deploy with Docker without sudo.`);
  if (shard) {
    await recordServer(directory, {
      ssh: destination,
      ...(requestedPort ? { port: requestedPort } : {}),
      publicHost
    });
    console.log('Saved to vps in gemwright.json. Next: gemwright shard deploy');
  } else
    console.log(
      `Next, from your shard directory: gemwright shard deploy --target vps --ssh ${destination} --public-host ${publicHost}`
    );
}
