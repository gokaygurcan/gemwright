import { parseArgs } from 'node:util';

export type Values = Record<string, string | boolean | undefined>;

export interface CommandSpec {
  usage: string;
  summary: string;
  sections: [string, string[]][];
  positional?: boolean;
}

const options: Record<string, { type: 'string' | 'boolean'; text: string; short?: string }> = {
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

export function commandHelp(spec: CommandSpec) {
  const sections = spec.sections.map(([title, names]) => {
    const lines = names.map((name) => {
      const option = options[name];
      const flag = `${option?.short ? `-${option.short}, ` : ''}--${name}${option?.type === 'string' ? ' <value>' : ''}`;
      return `  ${flag.padEnd(26)}${option?.text ?? ''}`;
    });
    return `${title}:\n${lines.join('\n')}`;
  });
  return `${spec.summary}\n\nUsage:\n  ${spec.usage}\n\n${[...sections, `Options:\n  ${'-h, --help'.padEnd(26)}Show help`].join('\n\n')}`;
}

export function parseCommand(name: string, spec: CommandSpec, args: string[]) {
  if (args.includes('--local')) throw new Error('--local is now --target local.');
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: !!spec.positional,
      options: Object.fromEntries([
        ...spec.sections
          .flatMap(([, names]) => names)
          .map((name) => {
            const { type = 'boolean', short } = options[name] ?? {};
            return [name, short ? { type, short } : { type }];
          }),
        ['help', { type: 'boolean', short: 'h' }]
      ])
    }) as { values: Values; positionals: string[] };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('. ')[0] : String(error);
    throw new Error(`${message}. Run gemwright ${name} --help.`);
  }
}

export function port(value: string | boolean | undefined, flag: string) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error(`${flag} must be a port from 1 to 65535.`);
  return number;
}

export const text = (value: string | boolean | undefined) => (typeof value === 'string' ? value : undefined);
