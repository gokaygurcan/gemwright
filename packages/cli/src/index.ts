#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { logs } from '@gemwright/deployment/logs';
import { pull } from '@gemwright/deployment/pull';

import chalk from 'chalk';

import { assetPath } from './assets';
import { deploy } from './deploy';
import { deploymentOptions } from './deploy-options';
import { initialize } from './init';
import { deployLocal } from './local-deploy';
import { localLogs, localPower, localPull, localRestore } from './local-ops';
import { updatePackages } from './package-update';
import { Cancelled } from './prompts';
import { confirmRestore, restore } from './restore';
import { updateNotice } from './update';
import { deployVps, validateVpsOptions } from './vps-deploy';
import { deployVpsRemote } from './vps-remote';

const help = `Usage: gemwright init [directory] [options]
       gemwright deploy [--files <path>] [--server] [--client] [--ai [--world <path> | --world-pull]]
       gemwright deploy --local [--server] [--client] [--ai] [--public-host <host>] [--server-port <n>] [--client-port <n>]
       gemwright stop --local [--server] [--client] [--ai]
       gemwright start --local [--server] [--client] [--ai]
       gemwright deploy --target vps --public-host <host> [--client --domain <host>] [--prepare]
       gemwright update [--server | --client | --ai] [--package-version <exact>]
       gemwright pull [--local] [--server] [--ai] [--logs] [--backups] [--output <dir>] [--cleanup]
       gemwright logs [--local] [--server] [--client] [--ai] [--watch]
       gemwright restore [--local] [--from <pull>] [--server] [--ai] [--yes]

Options:
  --package-version <exact>  Select a published component version (update; does not deploy)
  --name <name>         Shard name (default: Gemwright)
  --timezone <timezone> IANA timezone (default: local zone or Europe/London)
  --expansion <code>    Expansion (default: ej)
  --client-version <v>  Classic client version players use, e.g. 7.0.45.1 (required with --yes)
  --emulator <name>     Server emulator: servuo, sphere, sphere-x, runuo or modernuo (default: servuo)
  --git                 Initialize Git if outside a repository
  --yes                 Accept defaults for unanswered questions
  --mysql               Add MySQL for Sphere/Sphere-X scripts during deployment
  --files <path>        UO client files to import during deployment
  --server              Deploy the shard server (the default when no part is named)
  --client              Deploy the web client
  --ai                  Deploy AI residents (ServUO; settings under "ai" in gemwright.json)
  --world <path>        Teach AI residents the land from this world save: a pull, server or Saves folder (deploy --ai)
  --world-pull          Pull a fresh world save from the server and teach AI residents the land from it (deploy --ai)
  --local               Use the Docker Compose deployment on this machine (deploy, stop, start, logs, pull, restore)
  --server-port <n>     Local native client port (default: 2593; kept for later deploys)
  --client-port <n>     Local browser client port (default: 3000; kept for later deploys)
  --target <target>     Deployment target: railway (default) or vps
  --public-host <host>  Address native clients use (VPS: required; local: default 127.0.0.1)
  --domain <host>       Browser client HTTPS hostname
  --prepare             Generate a VPS bundle without installing or starting services
  --method <method>     VPS runtime: docker or native (Ubuntu with systemd)
  --ssh <destination>   Deploy over SSH using an alias or user@hostname
  --remote-path <path>  Dedicated deployment directory on the VPS
  --install-deps        Approve installation of missing VPS packages
  --logs                Pull recent service logs (pull)
  --backups             Also pull the server's own Backups folder (pull)
  --output <dir>        Where pull saves (default: .gemwright/pulls/<time>)
  --cleanup             Keep only the newest pull after a complete pull (pull)
  --watch               Keep following new log lines (logs)
  --from <pull>         Pull folder to restore (default: the newest pull)
  --help                Show this help
  --version             Show the installed version`;

function port(value: string | undefined, flag: string) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error(`${flag} must be a port from 1 to 65535.`);
  return number;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      'package-version': { type: 'string' },
      files: { type: 'string' },
      server: { type: 'boolean' },
      ai: { type: 'boolean' },
      world: { type: 'string' },
      'world-pull': { type: 'boolean' },
      client: { type: 'boolean' },
      local: { type: 'boolean' },
      'server-port': { type: 'string' },
      'client-port': { type: 'string' },
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
      'client-version': { type: 'string' },
      emulator: { type: 'string' },
      git: { type: 'boolean' },
      yes: { type: 'boolean' },
      mysql: { type: 'boolean' },
      logs: { type: 'boolean' },
      backups: { type: 'boolean' },
      output: { type: 'string' },
      cleanup: { type: 'boolean' },
      watch: { type: 'boolean' },
      from: { type: 'string' },
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
  if (command === 'update') {
    const selected = (['server', 'client', 'ai'] as const).filter((part) => values[part]);
    if (
      directory ||
      selected.length > 1 ||
      Object.keys(values).some((key) => !['server', 'client', 'ai', 'package-version'].includes(key))
    )
      throw new Error('Usage: gemwright update [--server | --client | --ai] [--package-version <exact>]');
    await updatePackages({ component: selected[0], version: values['package-version'] });
    return;
  }
  if (values['package-version']) throw new Error('--package-version is supported only by update.');
  if (command === 'pull') {
    if (positionals.length > 1)
      throw new Error(
        'Usage: gemwright pull [--local] [--server] [--ai] [--logs] [--backups] [--output <dir>] [--cleanup]'
      );
    const parts = {
      server: values.server,
      ai: values.ai,
      logs: values.logs,
      backups: values.backups,
      output: values.output,
      cleanup: values.cleanup
    };
    if (values.local) await localPull(parts);
    else await pull(parts, process.cwd(), console.log);
    return;
  }
  if (command === 'stop' || command === 'start') {
    if (!values.local) throw new Error(`gemwright ${command} works on local deployments only: add --local.`);
    if (directory || Object.keys(values).some((key) => !['local', 'server', 'client', 'ai'].includes(key)))
      throw new Error(`Usage: gemwright ${command} --local [--server] [--client] [--ai]`);
    await localPower(command, { server: values.server, client: values.client, ai: values.ai });
    return;
  }
  if (command === 'logs') {
    if (directory || Object.keys(values).some((key) => !['local', 'server', 'client', 'ai', 'watch'].includes(key)))
      throw new Error('Usage: gemwright logs [--local] [--server] [--client] [--ai] [--watch]');
    const parts = { server: values.server, client: values.client, ai: values.ai, watch: values.watch };
    if (values.local) await localLogs(parts);
    else await logs(parts);
    return;
  }
  if (command === 'restore') {
    const allowed = ['local', 'from', 'server', 'ai', 'yes'];
    if (directory || Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error('Usage: gemwright restore [--local] [--from <pull>] [--server] [--ai] [--yes]');
    const parts = { from: values.from, server: values.server, ai: values.ai, yes: values.yes };
    if (values.local) await localRestore(parts, confirmRestore);
    else await restore(parts);
    return;
  }
  if (command === 'deploy') {
    const allowed = [
      'local',
      'server-port',
      'client-port',
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
      'yes',
      'world',
      'world-pull'
    ];
    if (directory || extra.length || Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error('Usage: gemwright deploy [--files <path>] [--server] [--client] [--ai]');
    if ((values.world || values['world-pull']) && (!values.ai || values.local || values.target === 'vps'))
      throw new Error('--world and --world-pull teach the AI residents: use them with deploy --ai on Railway.');
    if (values.world && values['world-pull']) throw new Error('Use --world <path> or --world-pull, not both.');
    if (values.local) {
      if (
        Object.keys(values).some(
          (key) =>
            !['local', 'files', 'server', 'client', 'ai', 'public-host', 'server-port', 'client-port'].includes(key)
        )
      )
        throw new Error(
          'Usage: gemwright deploy --local [--files <path>] [--server] [--client] [--ai] [--public-host <host>]'
        );
      if (values['public-host']) validateVpsOptions({ publicHost: values['public-host'] });
      await deployLocal({
        files: values.files,
        server: values.server,
        client: values.client,
        ai: values.ai,
        publicHost: values['public-host'],
        serverPort: port(values['server-port'], '--server-port'),
        clientPort: port(values['client-port'], '--client-port')
      });
      return;
    }
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
    await deploy({ files: values.files, server: values.server, client: values.client, ai: values.ai }, process.cwd(), {
      saves: values.world,
      pull: values['world-pull']
    });
    return;
  }
  if (
    values.files ||
    values.server ||
    values.ai ||
    values.world ||
    values['world-pull'] ||
    values.client ||
    values.local ||
    values['server-port'] ||
    values['client-port'] ||
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

export async function run(args = process.argv.slice(2)): Promise<void> {
  const notice = args.includes('--version') ? Promise.resolve(undefined) : updateNotice();
  try {
    await main(args);
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
