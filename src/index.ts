#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import chalk from 'chalk';

import { deploy } from './deploy';
import { initialize } from './init';
import { Cancelled } from './prompts';

const help = `Usage: gemwright init [directory] [options]
       gemwright deploy [--files <path>]

Options:
  --name <name>          Shard name (default: Gemwright)
  --timezone <timezone> IANA timezone (default: local zone or Europe/London)
  --expansion <code>    Expansion (default: ej)
  --emulator <name>     Server emulator: servuo or sphere (default: servuo)
  --git                 Initialize Git if outside a repository
  --yes                 Accept defaults for unanswered questions
  --files <path>        UO client files to import during deployment
  --help                Show this help`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      files: { type: 'string' },
      name: { type: 'string' },
      timezone: { type: 'string' },
      expansion: { type: 'string' },
      emulator: { type: 'string' },
      git: { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean' }
    }
  });
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  const [command, directory, ...extra] = positionals;
  if (command === 'deploy') {
    if (directory || extra.length || Object.keys(values).some((key) => key !== 'files'))
      throw new Error('Usage: gemwright deploy [--files <path>]');
    await deploy({ files: values.files });
    return;
  }
  if (values.files) throw new Error('--files is only supported by deploy.');
  if (command !== 'init') throw new Error(`Unknown command: ${command}. Run gemwright --help.`);
  if (extra.length) throw new Error('Expected at most one directory. Run gemwright --help.');
  await initialize({ directory, ...values });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (error instanceof Cancelled) process.exitCode = 130;
    else {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
    }
  }
}
