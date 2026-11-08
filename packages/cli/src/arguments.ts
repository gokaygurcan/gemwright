import { parseArgs } from 'node:util';

import { type CommandSpec, options } from './commands';

export type Values = Record<string, string | boolean | undefined>;

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
