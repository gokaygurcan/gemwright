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

import {
  type ChoiceRequest,
  type ChoiceResult,
  type DecisionProvider,
  ProviderFailure,
  parseChoice
} from './decision-provider';

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
  constructor(config: { model: string; credentialEnv?: string; timeoutMs: number }) {
    const credentialEnv = config.credentialEnv ?? 'TYPESAFE_API_KEY';
    const key = process.env[credentialEnv]?.trim();
    if (!key || /[\r\n]/.test(key)) throw new Error(`Missing or invalid decision credential: ${credentialEnv}`);
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
export const JEV_DAILY_TOKEN_ALLOWANCE = Math.floor((0.16 * 1_000_000) / 0.042);
export const JEV_RESIDENT_TOKEN_ALLOWANCE = Math.floor((0.02 * 1_000_000) / 0.042);
