import * as prompts from '@clack/prompts';

export class Cancelled extends Error {}

export function answer<T>(value: T): Exclude<T, symbol> {
  if (prompts.isCancel(value)) {
    prompts.cancel('Initialization cancelled.');
    throw new Cancelled();
  }
  return value as Exclude<T, symbol>;
}
