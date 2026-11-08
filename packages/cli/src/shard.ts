import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { logs } from '@gemwright/deployment/logs';
import { command as runCommand } from '@gemwright/deployment/process';
import { pull } from '@gemwright/deployment/pull';
import { requireTarget, vpsRunner } from '@gemwright/deployment/target';
import { loadShard } from '@gemwright/server/config';

import { type CommandSpec, commandHelp, parseCommand, port, text } from './arguments';
import { localLogs, localPower, localPull, localRestore, localStatus } from './local-ops';
import { updatePackages } from './package-update';
import { confirmRestore, restore } from './restore';
import { shardDeploy } from './shard-deploy';
import { printStatus, railwayStatus, vpsStatus } from './status';
import { vpsCompose, vpsRestore } from './vps-ops';
import { setupServer } from './vps-setup';

const components: [string, string[]] = ['Component selection', ['server', 'client', 'ai']];
const targetOption: [string, string[]] = ['Target', ['target']];
const specs: Record<string, CommandSpec> = {
  setup: {
    usage: 'gemwright shard setup [options]',
    summary: 'Prepare a VPS for deployments.',
    sections: [['VPS', ['ssh', 'ssh-port', 'public-host', 'client', 'yes']]]
  },
  deploy: {
    usage: 'gemwright shard deploy [--server] [--client] [--ai] [--target <target>] [options]',
    summary:
      'Deploy selected components. Without component flags, the components already deployed to the target, or the server.',
    sections: [
      components,
      targetOption,
      ['General', ['files', 'yes']],
      ['AI deployment', ['world', 'world-pull']],
      ['Local deployment', ['server-port', 'client-port', 'public-host']],
      ['VPS deployment', ['public-host', 'domain', 'prepare', 'ssh', 'ssh-port', 'remote-path', 'install-deps']]
    ]
  },
  start: {
    usage: 'gemwright shard start [options]',
    summary: 'Start components.',
    sections: [components, targetOption]
  },
  stop: { usage: 'gemwright shard stop [options]', summary: 'Stop components.', sections: [components, targetOption] },
  status: {
    usage: 'gemwright shard status [options]',
    summary: 'Show deployment status.',
    sections: [components, targetOption]
  },
  logs: {
    usage: 'gemwright shard logs [options]',
    summary: 'View service logs.',
    sections: [components, targetOption, ['Logs', ['follow']]]
  },
  pull: {
    usage: 'gemwright shard pull [options]',
    summary: 'Download saves, data and backups.',
    sections: [
      ['Component selection', ['server', 'ai']],
      targetOption,
      ['Pull', ['logs', 'backups', 'output', 'cleanup']]
    ]
  },
  restore: {
    usage: 'gemwright shard restore [options]',
    summary: 'Restore from a previous pull.',
    sections: [['Component selection', ['server', 'ai']], targetOption, ['Restore', ['from', 'yes']]]
  },
  update: {
    usage: 'gemwright shard update [--server] [--client] [--ai] [--package-version <exact>]',
    summary: 'Select component package versions.',
    sections: [components, ['Update', ['package-version']]]
  }
};

export const shardHelp = `Manage a shard and its components.

Usage:
  gemwright shard <command> [options]

Commands:
${Object.entries(specs)
  .map(([name, spec]) => `  ${name.padEnd(12)}${spec.summary.split('. ')[0]?.replace(/\.$/, '')}`)
  .join('\n')}

Component selection:
  --server    Shard server
  --client    Web client
  --ai        AI residents

  Combine flags to select multiple components.
  Omit flags to select the components deployed to the target.

Target:
  --target <target>   local | railway | vps

Examples:
  gemwright shard deploy --server --ai
  gemwright shard logs --ai --follow
  gemwright shard stop --client

Run 'gemwright shard <command> --help' for command-specific options.`;

export async function shard(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'help' && rest[0]) return shard([rest[0], '--help']);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(shardHelp);
    return;
  }
  const spec = specs[command];
  if (!spec) throw new Error(`Unknown command: gemwright shard ${command}. Run gemwright shard --help.`);
  const { values } = parseCommand(`shard ${command}`, spec, rest);
  if (values.help) {
    console.log(commandHelp(spec));
    return;
  }
  const directory = process.cwd();
  if (!existsSync(join(directory, 'gemwright.json'))) throw new Error('No gemwright.json found.');
  const parts = { server: values.server === true, client: values.client === true, ai: values.ai === true };
  if (command === 'setup')
    return setupServer({
      ssh: text(values.ssh),
      sshPort: port(values['ssh-port'], '--ssh-port'),
      publicHost: text(values['public-host']),
      client: parts.client,
      yes: values.yes === true
    });
  if (command === 'update') {
    const selected = (['server', 'client', 'ai'] as const).filter((part) => parts[part]);
    for (const component of selected.length ? selected : [undefined])
      await updatePackages({ component, version: text(values['package-version']) });
    return;
  }
  const config = await loadShard(directory);
  if (command === 'deploy') return shardDeploy(values, directory, config);
  const target = requireTarget(directory, config, text(values.target));
  if (command === 'start' || command === 'stop') {
    if (target === 'railway')
      throw new Error(
        `Railway services are not ${command === 'stop' ? 'stopped' : 'started'} by Gemwright; use the Railway dashboard.`
      );
    if (target === 'vps') return vpsCompose(config, parts, (names) => [command, ...names], directory);
    return localPower(command, parts);
  }
  if (command === 'status') {
    const selected = (['server', 'client', 'ai'] as const).filter((part) => parts[part]);
    const rows =
      target === 'local'
        ? await localStatus(parts)
        : target === 'railway'
          ? await railwayStatus(selected, directory)
          : await vpsStatus(selected, vpsRunner(directory, config), directory, runCommand);
    if (printStatus(target, rows)) process.exitCode = 1;
    return;
  }
  if (command === 'logs') {
    const options = { ...parts, watch: values.follow === true };
    if (target === 'vps')
      return vpsCompose(
        config,
        parts,
        (names) => ['logs', '--timestamps', '--tail', '200', ...(options.watch ? ['--follow'] : []), ...names],
        directory
      );
    return target === 'local' ? localLogs(options) : logs(options);
  }
  if (command === 'pull') {
    const options = {
      server: parts.server,
      ai: parts.ai,
      logs: values.logs === true,
      backups: values.backups === true,
      output: text(values.output),
      cleanup: values.cleanup === true
    };
    if (target === 'local') return localPull(options);
    return pull(target === 'vps' ? { ...options, vps: vpsRunner(directory, config) } : options, directory, console.log);
  }
  const options = { from: text(values.from), server: parts.server, ai: parts.ai, yes: values.yes === true };
  if (target === 'vps') return vpsRestore(options, config, confirmRestore, directory);
  return target === 'local' ? localRestore(options, confirmRestore) : restore(options);
}
