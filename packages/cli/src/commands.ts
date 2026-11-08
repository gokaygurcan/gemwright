export interface CommandSpec {
  usage: string;
  summary: string;
  sections: [string, string[]][];
  positional?: boolean;
}

export const options: Record<string, { type: 'string' | 'boolean'; text: string; short?: string }> = {
  target: { type: 'string', text: 'local | railway | vps (default: the saved target)' },
  server: { type: 'boolean', text: 'Shard server' },
  client: { type: 'boolean', text: 'Web client' },
  ai: { type: 'boolean', text: 'AI residents (ServUO)' },
  files: { type: 'string', text: 'UO client files to import (default: clientFiles in gemwright.json)' },
  world: { type: 'string', text: 'Teach AI residents the land from this world save: a pull, server or Saves folder' },
  'world-pull': { type: 'boolean', text: 'Pull a fresh world save from the server and teach AI residents from it' },
  'public-host': { type: 'string', text: 'Address native clients use (VPS: required; local: default 127.0.0.1)' },
  'server-port': { type: 'string', text: 'Local native client port (default: 2593; kept for later deploys)' },
  'client-port': { type: 'string', text: 'Local browser client port (default: 3000; kept for later deploys)' },
  domain: { type: 'string', text: 'Browser client HTTPS hostname (VPS)' },
  prepare: { type: 'boolean', text: 'Generate a VPS bundle without installing or starting services' },
  ssh: { type: 'string', text: 'SSH destination: an alias or user@hostname' },
  'ssh-port': { type: 'string', text: "SSH port (default: the SSH configuration's, usually 22)" },
  'remote-path': { type: 'string', text: 'Dedicated deployment directory on the VPS' },
  'install-deps': { type: 'boolean', text: 'Approve installation of missing VPS packages' },
  follow: { type: 'boolean', short: 'f', text: 'Keep following new lines' },
  logs: { type: 'boolean', text: 'Download recent service logs (gemwright shard logs views them)' },
  backups: { type: 'boolean', text: "Also the server's own Backups folder" },
  output: { type: 'string', text: 'Where to save (default: .gemwright/pulls/<time>)' },
  cleanup: { type: 'boolean', text: 'Keep only the newest pull after a complete pull' },
  from: { type: 'string', text: 'Pull folder to restore (default: the newest pull)' },
  'package-version': { type: 'string', text: 'Select an exact published version (does not deploy)' },
  name: { type: 'string', text: 'Shard name (default: Gemwright)' },
  timezone: { type: 'string', text: 'IANA timezone (default: local zone or Europe/London)' },
  expansion: { type: 'string', text: 'Expansion (default: ej)' },
  'client-version': { type: 'string', text: 'Classic client version players use, e.g. 7.0.45.1 (required with --yes)' },
  emulator: { type: 'string', text: 'Server emulator: servuo, sphere, sphere-x, runuo or modernuo (default: servuo)' },
  git: { type: 'boolean', text: 'Initialize Git if outside a repository' },
  mysql: { type: 'boolean', text: 'Add MySQL for Sphere/Sphere-X scripts during deployment' },
  yes: { type: 'boolean', text: 'Answer yes and accept defaults; never prompt' }
};

export const initSpec: CommandSpec = {
  usage: 'gemwright init [directory] [options]',
  summary: 'Initialize a shard project.',
  sections: [['Init', ['name', 'timezone', 'expansion', 'client-version', 'emulator', 'git', 'mysql', 'yes']]],
  positional: true
};

const components: [string, string[]] = ['Component selection', ['server', 'client', 'ai']];
const targetOption: [string, string[]] = ['Target', ['target']];
export const shardSpecs: Record<string, CommandSpec> = {
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
