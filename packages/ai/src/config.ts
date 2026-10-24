import { type CharacterArchetype, resolveArchetype } from './archetypes';

export interface CharacterTemplate {
  id: string;
  version: number;
  label: string;
  archetype?: CharacterArchetype;
  creation: {
    namePrefix: string;
    city: string;
    skills: Record<string, number>;
    equipment: string[];
    provisioning: 'normal-character-creation';
  };
  behavior: {
    activities: string[];
    trainingGoals: Record<string, number>;
    riskTolerance: number;
    sociability: number;
    cooperation: number;
    supplies: Record<string, number>;
    bankAtWeightRatio: number;
    corpseRecovery: 'seek-help' | 'recover-if-safe' | 'replace-equipment';
    // Runtime-only per-resident shading; never read from configuration.
    temperament?: import('./temperament').Temperament;
  };
}

export type Allocation =
  | { mode: 'weighted'; entries: { templateId: string; weight: number }[] }
  | { mode: 'fixed'; entries: { templateId: string; count: number }[] };

export interface PopulationConfig {
  schemaVersion: 1;
  shardId: string;
  targetPopulation: number;
  templates: CharacterTemplate[];
  allocation: Allocation;
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function object(value: unknown, path: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!keys.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(result, key)) fail(`${path}.${key}`, 'required field');
  return result;
}

function string(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    fail(path, 'expected nonempty text without surrounding whitespace or control characters');
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) fail(path, 'expected a lowercase slug');
  return result;
}

function number(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    fail(path, `expected ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function strings(value: unknown, path: string, nonempty = false): string[] {
  const result = array(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
  if (nonempty && !result.length) fail(path, 'must contain at least one entry');
  if (new Set(result).size !== result.length) fail(path, 'duplicate entries');
  return result;
}

function amounts(value: unknown, path: string, integer = false): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected a name-to-amount object');
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      string(key, path),
      number(entry, `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER, integer)
    ])
  );
}

function template(value: unknown, index: number): CharacterTemplate {
  const path = `templates[${index}]`;
  const t = object(value, path, ['id', 'version', 'label', 'creation', 'behavior'], ['archetype']);
  const c = object(t.creation, `${path}.creation`, ['namePrefix', 'city', 'skills', 'equipment', 'provisioning']);
  if (c.provisioning !== 'normal-character-creation')
    fail(`${path}.creation.provisioning`, 'only normal-character-creation is implemented as a policy');
  const b = object(t.behavior, `${path}.behavior`, [
    'activities',
    'trainingGoals',
    'riskTolerance',
    'sociability',
    'cooperation',
    'supplies',
    'bankAtWeightRatio',
    'corpseRecovery'
  ]);
  if (!['seek-help', 'recover-if-safe', 'replace-equipment'].includes(b.corpseRecovery as string))
    fail(`${path}.behavior.corpseRecovery`, 'unknown recovery policy');
  return {
    id: id(t.id, `${path}.id`),
    version: number(t.version, `${path}.version`, 1, Number.MAX_SAFE_INTEGER, true),
    label: string(t.label, `${path}.label`),
    ...(t.archetype === undefined ? {} : { archetype: resolveArchetype(t.archetype) }),
    creation: {
      namePrefix: string(c.namePrefix, `${path}.creation.namePrefix`),
      city: string(c.city, `${path}.creation.city`),
      skills: amounts(c.skills, `${path}.creation.skills`),
      equipment: strings(c.equipment, `${path}.creation.equipment`),
      provisioning: 'normal-character-creation'
    },
    behavior: {
      activities: strings(b.activities, `${path}.behavior.activities`, true),
      trainingGoals: amounts(b.trainingGoals, `${path}.behavior.trainingGoals`),
      riskTolerance: number(b.riskTolerance, `${path}.behavior.riskTolerance`, 0, 1),
      sociability: number(b.sociability, `${path}.behavior.sociability`, 0, 1),
      cooperation: number(b.cooperation, `${path}.behavior.cooperation`, 0, 1),
      supplies: amounts(b.supplies, `${path}.behavior.supplies`, true),
      bankAtWeightRatio: number(b.bankAtWeightRatio, `${path}.behavior.bankAtWeightRatio`, Number.EPSILON, 1),
      corpseRecovery: b.corpseRecovery as CharacterTemplate['behavior']['corpseRecovery']
    }
  };
}

export function validateConfig(value: unknown): PopulationConfig {
  const root = object(value, 'config', ['schemaVersion', 'shardId', 'targetPopulation', 'templates', 'allocation']);
  if (root.schemaVersion !== 1) fail('schemaVersion', 'unsupported version');
  const templates = array(root.templates, 'templates').map(template);
  if (!templates.length) fail('templates', 'must contain at least one template');
  const ids = new Set(templates.map((t) => t.id));
  if (ids.size !== templates.length) fail('templates', 'duplicate template IDs');
  const a = object(root.allocation, 'allocation', ['mode', 'entries']);
  if (a.mode !== 'fixed' && a.mode !== 'weighted') fail('allocation.mode', 'expected fixed or weighted');
  const field = a.mode === 'fixed' ? 'count' : 'weight';
  const entries = array(a.entries, 'allocation.entries').map((value, index) => {
    const path = `allocation.entries[${index}]`;
    const entry = object(value, path, ['templateId', field]);
    const templateId = id(entry.templateId, `${path}.templateId`);
    if (!ids.has(templateId)) fail(path, `unknown template ${templateId}`);
    return {
      templateId,
      amount: number(entry[field], `${path}.${field}`, a.mode === 'fixed' ? 0 : 1, Number.MAX_SAFE_INTEGER, true)
    };
  });
  if (!entries.length || new Set(entries.map((e) => e.templateId)).size !== entries.length)
    fail('allocation.entries', 'expected unique, nonempty entries');
  const sum = entries.reduce((sum, entry) => sum + entry.amount, 0);
  if (!Number.isSafeInteger(sum)) fail('allocation.entries', 'total exceeds safe integer range');
  const targetPopulation = number(root.targetPopulation, 'targetPopulation', 0, Number.MAX_SAFE_INTEGER, true);
  if (a.mode === 'fixed' && sum !== targetPopulation) fail('allocation', 'fixed counts must sum to targetPopulation');
  return {
    schemaVersion: 1,
    shardId: id(root.shardId, 'shardId'),
    targetPopulation,
    templates,
    allocation:
      a.mode === 'fixed'
        ? { mode: 'fixed', entries: entries.map((e) => ({ templateId: e.templateId, count: e.amount })) }
        : { mode: 'weighted', entries: entries.map((e) => ({ templateId: e.templateId, weight: e.amount })) }
  };
}

export function allocatePopulation(config: PopulationConfig): Record<string, number> {
  const counts = Object.fromEntries(config.templates.map((t) => [t.id, 0]));
  if (config.allocation.mode === 'fixed') {
    for (const entry of config.allocation.entries) counts[entry.templateId] = entry.count;
    return counts;
  }
  const total = config.allocation.entries.reduce((sum, entry) => sum + BigInt(entry.weight), 0n);
  const shares = config.allocation.entries.map((entry) => {
    const product = BigInt(config.targetPopulation) * BigInt(entry.weight);
    return { templateId: entry.templateId, count: Number(product / total), remainder: product % total };
  });
  let remaining = config.targetPopulation - shares.reduce((sum, share) => sum + share.count, 0);
  shares.sort((a, b) =>
    a.remainder === b.remainder ? (a.templateId < b.templateId ? -1 : 1) : a.remainder > b.remainder ? -1 : 1
  );
  for (const share of shares) {
    counts[share.templateId] = share.count + (remaining > 0 ? 1 : 0);
    remaining--;
  }
  return counts;
}
