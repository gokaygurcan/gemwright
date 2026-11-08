#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';

import { type CommandSpec, commandHelp, parseCommand, text } from './arguments';
import { assetPath } from './assets';
import { initialize } from './init';
import { Cancelled } from './prompts';
import { shard } from './shard';
import { updateNotice } from './update';

const help = `Gemwright — Create and manage Ultima Online shards.

Usage:
  gemwright <command> [options]

Commands:
  init [directory]     Initialize a shard project
  shard <command>      Manage a shard

Options:
  -h, --help           Show help
  -V, --version        Show version

Examples:
  gemwright init ./my-shard
  gemwright shard deploy
  gemwright shard status

Run 'gemwright shard --help' for shard commands.`;

const init: CommandSpec = {
  usage: 'gemwright init [directory] [options]',
  summary: 'Initialize a shard project.',
  sections: [['Init', ['name', 'timezone', 'expansion', 'client-version', 'emulator', 'git', 'mysql', 'yes']]],
  positional: true
};

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === '--version' || command === '-V') {
    const { version } = JSON.parse(await readFile(assetPath('package.json'), 'utf8'));
    console.log(version);
    return;
  }
  if (command === 'help' && rest.length) return main([...rest, '--help']);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(help);
    return;
  }
  if (['deploy', 'start', 'stop', 'status', 'logs', 'pull', 'restore', 'update', 'setup'].includes(command))
    throw new Error(`gemwright ${command} is now gemwright shard ${command}.`);
  if (command === 'shard') return shard(rest);
  if (command !== 'init') throw new Error(`Unknown command: ${command}. Run gemwright --help.`);
  const { values, positionals } = parseCommand('init', init, rest);
  if (values.help) {
    console.log(commandHelp(init));
    return;
  }
  if (positionals.length > 1) throw new Error('Expected at most one directory. Run gemwright init --help.');
  await initialize({
    directory: positionals[0],
    name: text(values.name),
    timezone: text(values.timezone),
    expansion: text(values.expansion),
    'client-version': text(values['client-version']),
    emulator: text(values.emulator),
    git: values.git === true,
    mysql: values.mysql === true,
    yes: values.yes === true
  });
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
