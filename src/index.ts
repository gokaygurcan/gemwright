#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import chalk from 'chalk';

import { assetPath } from './assets';
import { deploy } from './deploy';
import { deploymentOptions } from './deploy-options';
import { initialize } from './init';
import { Cancelled } from './prompts';
import { updateNotice } from './update';
import { deployVps } from './vps-deploy';
import { deployVpsRemote } from './vps-remote';

const help = `Usage: gemwright init [directory] [options]
       gemwright deploy [--files <path>] [--server] [--client] [--ai]
       gemwright deploy --target vps --public-host <host> [--client --domain <host>] [--prepare]

Options:
  --name <name>         Shard name (default: Gemwright)
  --timezone <timezone> IANA timezone (default: local zone or Europe/London)
  --expansion <code>    Expansion (default: ej)
  --emulator <name>     Server emulator: servuo, sphere, sphere-x, runuo or modernuo (default: servuo)
  --git                 Initialize Git if outside a repository
  --yes                 Accept defaults for unanswered questions
  --mysql               Add MySQL for Sphere/Sphere-X scripts during deployment
  --files <path>        UO client files to import during deployment
  --server              Deploy the shard server (the default when no part is named)
  --client              Deploy the web client
  --ai                  Deploy AI residents (ServUO; settings under "ai" in gemwright.json)
  --target <target>     Deployment target: railway (default) or vps
  --public-host <host>  VPS public IPv4 address or hostname for native clients
  --domain <host>       Browser client HTTPS hostname
  --prepare             Generate a VPS bundle without installing or starting services
  --method <method>     VPS runtime: docker or native (Ubuntu with systemd)
  --ssh <destination>   Deploy over SSH using an alias or user@hostname
  --remote-path <path>  Dedicated deployment directory on the VPS
  --install-deps        Approve installation of missing VPS packages
  --help                Show this help
  --version             Show the installed version`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      files: { type: 'string' },
      server: { type: 'boolean' },
      ai: { type: 'boolean' },
      client: { type: 'boolean' },
      target: { type: 'string' },
      'public-host': { type: 'string' },
      domain: { type: 'string' },
      prepare: { type: 'boolean' },
      method: { type: 'string' },
      ssh: { type: 'string' },
      'remote-path': { type: 'string' },
      'install-deps': { type: 'boolean' },
      name: { type: 'string' },
      timezone: { type: 'string' },
      expansion: { type: 'string' },
      emulator: { type: 'string' },
      git: { type: 'boolean' },
      yes: { type: 'boolean' },
      mysql: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' }
    }
  });
  if (values.version) {
    const { version } = JSON.parse(await readFile(assetPath('package.json'), 'utf8'));
    console.log(version);
    return;
  }
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const [command, directory, ...extra] = positionals;
  if (command === 'deploy') {
    const allowed = [
      'files',
      'server',
      'client',
      'ai',
      'target',
      'public-host',
      'domain',
      'prepare',
      'method',
      'ssh',
      'remote-path',
      'install-deps',
      'yes'
    ];
    if (directory || extra.length || Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error('Usage: gemwright deploy [--files <path>] [--server] [--client] [--ai]');
    const options = await deploymentOptions({
      target: values.target,
      files: values.files,
      client: values.client,
      publicHost: values['public-host'],
      domain: values.domain,
      prepare: values.prepare,
      method: values.method,
      ssh: values.ssh,
      remotePath: values['remote-path'],
      installDeps: values['install-deps'],
      yes: values.yes
    });
    if (options.target === 'vps') {
      if (values.ai) throw new Error('AI residents deploy to Railway only for now.');
      if (values.client && !values.server) console.log('VPS deployments always include the server for now.');
      if (options.ssh) await deployVpsRemote(options);
      else await deployVps(options);
      await mkdir(join(process.cwd(), '.gemwright'), { recursive: true });
      await writeFile(join(process.cwd(), '.gemwright/deployment.json'), `${JSON.stringify(options, null, 2)}\n`, {
        mode: 0o600
      });
      return;
    }
    if ((values.client || values.ai) && !values.server)
      console.log('Deploying only the named parts; add --server to deploy the shard as well.');
    await deploy({ files: values.files, server: values.server, client: values.client, ai: values.ai });
    return;
  }
  if (
    values.files ||
    values.server ||
    values.ai ||
    values.client ||
    values.target ||
    values['public-host'] ||
    values.domain ||
    values.prepare ||
    values.method ||
    values.ssh ||
    values['remote-path'] ||
    values['install-deps']
  )
    throw new Error('Deployment options are only supported by deploy.');
  if (command !== 'init') throw new Error(`Unknown command: ${command}. Run gemwright --help.`);
  if (extra.length) throw new Error('Expected at most one directory. Run gemwright --help.');
  await initialize({ directory, ...values });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const notice = process.argv.includes('--version') ? Promise.resolve(undefined) : updateNotice();
  try {
    await main();
  } catch (error) {
    if (error instanceof Cancelled) process.exitCode = 130;
    else {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
    }
  } finally {
    const message = await notice;
    if (message) console.error(`\n${chalk.yellow(message)}\n`);
  }
}
