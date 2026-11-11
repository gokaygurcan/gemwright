import {
  type ChoiceRequest,
  type ChoiceResult,
  type DecisionProvider,
  ProviderFailure,
  parseChoice,
  type WireExchange
} from './decision-provider';

// Rounded-up rates and maximum billed input contexts: developers.cloudflare.com/workers-ai/models/clef/.
export const CLEF_MODELS = {
  clef: { neuronsPerMillion: 21819, context: 65536 },
  'clef-flash': { neuronsPerMillion: 3455, context: 24576 },
  'clef-omni': { neuronsPerMillion: 13637, context: 64000 }
} as const;
export type ClefModel = keyof typeof CLEF_MODELS;
export const CLEF_DAILY_UNITS = 10000 * 1000000;

export class ClefProvider implements DecisionProvider {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch
  ) {
    if (!/^[a-f0-9]{32}$/i.test(accountId) || !token.trim() || /[\r\n]/.test(token))
      throw new Error('Invalid Cloudflare account ID or API token');
  }

  async choose(request: ChoiceRequest, signal: AbortSignal): Promise<ChoiceResult> {
    if (!Object.hasOwn(CLEF_MODELS, request.model)) throw new ProviderFailure('unsupported-model');
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/@cf/cloudflare/${request.model}`;
    const wire: WireExchange = { url, sent: JSON.stringify(request) };
    const fail = (code: string, retryAfterMs = 0) => new ProviderFailure(code, retryAfterMs, undefined, wire);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: wire.sent,
        redirect: 'error',
        signal
      });
    } catch {
      throw fail(signal.aborted ? 'cancelled' : 'network-error');
    }
    wire.status = response.status;
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 64000) throw fail('response-too-large');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    wire.received = Buffer.concat(parts).toString('utf8');
    let envelope: { success?: boolean; result?: unknown; errors?: { code?: number }[] };
    try {
      envelope = JSON.parse(wire.received);
      if (!envelope || typeof envelope !== 'object') throw new Error('Invalid envelope');
    } catch {
      throw fail(response.ok ? 'invalid-response' : `http-${response.status}`);
    }
    if (!response.ok || envelope.success !== true) {
      if (Array.isArray(envelope.errors) && envelope.errors.some((error) => error?.code === 3036))
        throw fail('daily-neuron-quota');
      const retry = response.headers.get('retry-after');
      const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 60000;
      throw fail(`http-${response.status}`, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 600000)) : 60000);
    }
    let result: ChoiceResult;
    try {
      result = parseChoice(envelope.result, request);
    } catch (error) {
      throw error instanceof ProviderFailure ? fail(error.code) : error;
    }
    if (result.inputTokens > CLEF_MODELS[request.model as ClefModel].context) throw fail('invalid-usage');
    return { ...result, wire };
  }
}
