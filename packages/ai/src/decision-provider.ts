import { decisionProviders } from '@gemwright/common/config/shard';
import type { DecisionProviderSettings } from '@gemwright/common/config/types';

export interface DecisionConfig {
  schemaVersion: 1;
  providers: DecisionProviderSettings[];
  timeoutMs: number;
  minIntervalMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  maxRequestBytes: number;
  // The share of residents that ask the model (0-1); the rest decide locally, as the baseline the
  // model is compared against at population scale (analyze /decisions).
  share: number;
}

// Whether a resident is in the model's share: fixed by its id, so the groups stay the same.
export function inModelShare(residentId: string, share: number) {
  let hash = 0;
  for (const char of residentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 100 < Math.round(share * 100);
}

export function validateDecisionConfig(value: unknown): DecisionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid decision configuration');
  const { provider, model, credentialEnv, ...config } = value as Record<string, unknown>;
  if (config.providers !== undefined && [provider, model, credentialEnv].some((field) => field !== undefined))
    throw new Error('Use providers instead of mixing legacy decision fields with the provider list');
  const providers = decisionProviders(
    config.providers !== undefined ? config.providers : provider === undefined ? 'local' : provider
  );
  if (config.providers === undefined) {
    const first = providers[0];
    if (first && first.provider !== 'local') {
      if (model !== undefined) first.model = model as string;
      if (credentialEnv !== undefined) first.credentialEnv = credentialEnv as string;
    }
    decisionProviders(providers);
  }
  const defaults: DecisionConfig = {
    schemaVersion: 1,
    providers,
    timeoutMs: Math.min(5000, 1500 * Math.max(1, providers.length - 1)),
    minIntervalMs: 30000,
    maxRequestsPerRun: 12,
    maxRequestsPerDay: 200,
    maxRequestBytes: 12000,
    share: 1
  };
  if (Object.keys(config).some((key) => !Object.hasOwn(defaults, key)))
    throw new Error('Unknown decision configuration field');
  const result = { ...defaults, ...config, providers } as DecisionConfig;
  if (
    result.schemaVersion !== 1 ||
    typeof result.share !== 'number' ||
    !Number.isFinite(result.share) ||
    result.share < 0 ||
    result.share > 1
  )
    throw new Error('Unsupported decision configuration');
  const limits: [keyof DecisionConfig, number, number, boolean][] = [
    ['timeoutMs', 100, 5000, true],
    ['minIntervalMs', 0, 600000, true],
    ['maxRequestsPerRun', 0, 10000, true],
    ['maxRequestsPerDay', 0, 50000, true],
    ['maxRequestBytes', 1000, 16000, true]
  ];
  for (const [key, min, max, integer] of limits) {
    const n = result[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
      throw new Error(`Invalid decision limit: ${key}`);
  }
  return result;
}

export interface ChoiceRequest {
  model: string;
  state: unknown;
  questions: { action: { type: 'choice'; instructions: string; criteria: Record<string, string> } };
}
export interface ChoiceResult {
  model: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  attempts?: ProviderAttempt[];
}
export interface ProviderAttempt {
  provider: 'clef' | 'jev';
  model: string;
  reason: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface DecisionProvider {
  choose(
    request: ChoiceRequest,
    signal: AbortSignal,
    onAttempt?: (attempt: ProviderAttempt) => void
  ): Promise<ChoiceResult>;
}
export class ProviderFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
    readonly attempts?: ProviderAttempt[]
  ) {
    super(code);
  }
}
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function parseChoice(value: unknown, request: ChoiceRequest): ChoiceResult {
  if (!value || typeof value !== 'object') throw new ProviderFailure('invalid-response');
  const result = value as Record<string, unknown>;
  const answers = result.answers as Record<string, unknown> | undefined;
  const answer = answers?.action as Record<string, unknown> | undefined;
  const usage = result.usage as Record<string, unknown> | undefined;
  if (
    result.model !== request.model ||
    answer?.type !== 'choice' ||
    typeof answer.choice !== 'string' ||
    !Object.hasOwn(request.questions.action.criteria, answer.choice) ||
    !probability(answer.confidence) ||
    !answer.probabilities ||
    typeof answer.probabilities !== 'object' ||
    Array.isArray(answer.probabilities)
  )
    throw new ProviderFailure('invalid-response');
  const probabilities = answer.probabilities as Record<string, number>;
  const keys = Object.keys(request.questions.action.criteria);
  if (
    Object.keys(probabilities).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(probabilities, key) || !probability(probabilities[key])) ||
    Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02
  )
    throw new ProviderFailure('invalid-probabilities');
  if (
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    Number(usage.input_tokens) < 0 ||
    Number(usage.output_tokens) < 0
  )
    throw new ProviderFailure('invalid-usage');
  return {
    model: result.model as string,
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities,
    inputTokens: Number(usage.input_tokens),
    outputTokens: Number(usage.output_tokens)
  };
}

// A day's allowance opens with the day: the elapsed share plus a tenth, so a busy hour cannot spend
// what the rest of the UTC day needs.
export const pacedAllowance = (daily: number, now = Date.now()) => {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const fraction = Math.min(1, Math.max(0, (now - dayStart) / 86_400_000));
  return daily * Math.min(1, fraction + 0.1);
};
