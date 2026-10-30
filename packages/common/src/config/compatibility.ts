import Ajv from 'ajv';

import schema from './gemwright.schema.json';
import type { ShardConfig } from './types';

export const components = ['server', 'client', 'ai'] as const;
export type Component = (typeof components)[number];
export const packageNames: Record<Component, string> = {
  server: '@gemwright/server',
  client: '@gemwright/client',
  ai: '@gemwright/ai'
};
// Schema 1 is the supported pre-1.0 deployment interface, not a protocol compatibility promise.
export const compatibility = { 1: { server: '>=0.7.0 <1.0.0', client: '>=0.7.0 <1.0.0', ai: '>=0.7.0 <1.0.0' } };
const validate = new Ajv({ allErrors: true }).compile<ShardConfig>(schema);

export function stableVersion(value: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const parts = value.split('.').map(Number);
  if (parts.every(Number.isSafeInteger)) return parts;
}
export function compareVersions(left: string, right: string): number {
  const a = stableVersion(left),
    b = stableVersion(right);
  if (!a || !b) throw new Error('Exact stable package versions are required.');
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}
export function assertCompatible(schemaVersion: number, component: Component, version: string): void {
  if (schemaVersion !== 1)
    throw new Error(`Unknown gemwright.json schemaVersion ${schemaVersion}. Update the CLI: npm i -g gemwright@latest`);
  if (!stableVersion(version) || compareVersions(version, '0.7.0') < 0 || compareVersions(version, '1.0.0') >= 0)
    throw new Error(
      `${packageNames[component]}@${version} is unsupported by schemaVersion 1 (${compatibility[1][component]}). Update the CLI: npm i -g gemwright@latest`
    );
}
export function validateSchema(input: unknown): asserts input is ShardConfig {
  const version = (input as ShardConfig | null)?.schemaVersion ?? 1;
  if (version !== 1) assertCompatible(version, 'server', '0.7.0');
  if (!validate(input))
    throw new Error(
      `Invalid gemwright.json: ${validate.errors?.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`
    );
  for (const component of components) {
    const selected = input.packages?.[component];
    if (selected) assertCompatible(version, component, selected);
  }
}
