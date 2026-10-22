import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  choice,
  type EntryType,
  RateLimitError,
  TypeSafeClient
} from '@typesafe-ai/sdk';

export interface DecisionConfig {
  schemaVersion: 1;
  provider: 'jev' | 'local';
  model: 'jev-1.13.0' | 'jev-1.14.0';
  credentialEnv: string;
  timeoutMs: number;
  minIntervalMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  maxDailyCostUsd: number;
  maxRequestBytes: number;
}

export function validateDecisionConfig(value: unknown): DecisionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid decision configuration');
  const config = value as Record<string, unknown>;
  const defaults: DecisionConfig = {
    schemaVersion: 1,
    provider: 'local',
    model: 'jev-1.13.0',
    credentialEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 1500,
    minIntervalMs: 30000,
    maxRequestsPerRun: 12,
    maxRequestsPerDay: 200,
    maxDailyCostUsd: 0.02,
    maxRequestBytes: 12000
  };
  if (Object.keys(config).some((key) => !Object.hasOwn(defaults, key)))
    throw new Error('Unknown decision configuration field');
  const result = { ...defaults, ...config } as DecisionConfig;
  if (
    result.schemaVersion !== 1 ||
    !['jev', 'local'].includes(result.provider) ||
    !['jev-1.13.0', 'jev-1.14.0'].includes(result.model) ||
    typeof result.credentialEnv !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,79}$/.test(result.credentialEnv)
  )
    throw new Error('Unsupported decision provider, model, or credential reference');
  const limits: [keyof DecisionConfig, number, number, boolean][] = [
    ['timeoutMs', 100, 5000, true],
    ['minIntervalMs', 0, 600000, true],
    ['maxRequestsPerRun', 0, 10000, true],
    ['maxRequestsPerDay', 0, 50000, true],
    ['maxDailyCostUsd', 0, 5, false],
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
}
export interface DecisionProvider {
  choose(request: ChoiceRequest, signal: AbortSignal): Promise<ChoiceResult>;
}
export class ProviderFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0
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

// Jev through the official SDK (@typesafe-ai/sdk). The API root is fixed in code, so a
// TYPESAFE_BASE_URL in the environment can never redirect the credential. The coordinator owns
// timeouts, cancellation and budgets, so the SDK makes exactly one attempt.
const API_ROOT = 'https://api.typesafe.ai';
const MAX_RESPONSE_BYTES = 64000;

// SDK 0.7's bufferResponse takes a reader on the original response body and releases it; under
// Bun a body that ever had a reader counts as used, so the SDK's later text() throws "Body already
// used". This fetch reads the body itself (bounded, cancellable) and hands the SDK a buffered
// response that reports no stream body, so bufferResponse skips it while text() still works.
export const bufferedFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, { ...init, redirect: 'error' });
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      parts.push(part.value);
    }
  const buffered = Buffer.concat(parts);
  const wrap = (): Response => {
    const copy = new Response(buffered, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    Object.defineProperty(copy, 'body', { get: () => null });
    Object.defineProperty(copy, 'clone', { value: wrap });
    return copy;
  };
  return wrap();
};

export class JevProvider implements DecisionProvider {
  private readonly client: TypeSafeClient;
  constructor(config: DecisionConfig) {
    const key = process.env[config.credentialEnv]?.trim();
    if (!key || /[\r\n]/.test(key)) throw new Error(`Missing or invalid decision credential: ${config.credentialEnv}`);
    this.client = new TypeSafeClient({
      apiKey: key,
      baseURL: API_ROOT,
      defaultModel: config.model,
      timeout: config.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: bufferedFetch
    });
  }
  async choose(request: ChoiceRequest, signal: AbortSignal): Promise<ChoiceResult> {
    const { instructions, criteria } = request.questions.action;
    let result: unknown;
    try {
      result = await this.client.systemOne(
        {
          model: request.model,
          state: (request.state ?? {}) as NonNullable<EntryType>,
          questions: { action: choice(instructions, criteria) }
        },
        { signal }
      );
    } catch (error) {
      if (error instanceof APIUserAbortError) throw new ProviderFailure('cancelled');
      if (error instanceof APITimeoutError) throw new ProviderFailure('timeout');
      if (error instanceof RateLimitError)
        throw new ProviderFailure('http-429', Math.min(error.retryAfterMs ?? 0, 600000));
      if (error instanceof APIError) throw new ProviderFailure(`http-${error.status}`);
      if (error instanceof APIConnectionError)
        throw new ProviderFailure(signal.aborted ? 'cancelled' : 'network-error');
      throw new ProviderFailure('invalid-response');
    }
    // The SDK types the answer; it is still checked against the offered candidates.
    return parseChoice(result, request);
  }
}

// Published Jev 1.13/1.14 input price (docs.typesafe.ai/models); output is free.
export const costUsd = (tokens: number) => (tokens * 0.042) / 1_000_000;
