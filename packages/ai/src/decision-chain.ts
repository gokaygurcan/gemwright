import { CLEF_DAILY_UNITS, CLEF_MODELS, type ClefModel, ClefProvider } from './decision-clef';
import { JEV_DAILY_TOKEN_ALLOWANCE, JevProvider } from './decision-jev';
import {
  type ChoiceRequest,
  type ChoiceResult,
  type DecisionConfig,
  type DecisionProvider,
  type ProviderAttempt,
  ProviderFailure
} from './decision-provider';
import type { SpendLedger } from './spend-ledger';

export class DecisionChain implements DecisionProvider {
  private readonly clients: Partial<Record<'clef' | 'jev', DecisionProvider>> = {};
  private readonly account: string;

  constructor(
    private readonly config: DecisionConfig,
    private readonly ledger: SpendLedger,
    providers?: { clef?: DecisionProvider; jev?: DecisionProvider; accountId?: string },
    private readonly now: () => number = Date.now
  ) {
    this.account = `cloudflare:${providers?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? 'missing'}`;
    for (const entry of config.providers) {
      if (entry.provider === 'local') continue;
      if (providers) {
        this.clients[entry.provider] = providers[entry.provider];
        continue;
      }
      if (entry.provider === 'clef') {
        const token = process.env[entry.credentialEnv ?? 'CLOUDFLARE_API_TOKEN'];
        if (process.env.CLOUDFLARE_ACCOUNT_ID && token)
          this.clients.clef = new ClefProvider(process.env.CLOUDFLARE_ACCOUNT_ID, token);
      } else if (process.env[entry.credentialEnv ?? 'TYPESAFE_API_KEY']) {
        this.clients.jev = new JevProvider({ ...entry, timeoutMs: config.timeoutMs });
      }
    }
  }

  async choose(
    request: ChoiceRequest,
    signal: AbortSignal,
    onAttempt?: (attempt: ProviderAttempt) => void
  ): Promise<ChoiceResult> {
    const deadline = Date.now() + this.config.timeoutMs;
    const attempts: ProviderAttempt[] = [];
    const record = (attempt: ProviderAttempt) => {
      attempts.push(attempt);
      onAttempt?.(attempt);
    };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const midnight = Date.parse(`${day}T00:00:00Z`) + 86400000;
    const steps = this.config.providers.flatMap((entry) => {
      if (entry.provider === 'local') return [];
      const spec = entry.provider === 'clef' ? CLEF_MODELS[entry.model as ClefModel] : undefined;
      return [
        {
          provider: entry.provider,
          model: entry.model,
          client: this.clients[entry.provider],
          key: entry.provider === 'clef' ? this.account : 'jev',
          // Clef reserves its entire context; uncertain charges retain the reservation.
          reservation: spec
            ? spec.context * spec.neuronsPerMillion
            : Buffer.byteLength(JSON.stringify({ ...request, model: entry.model })) + 1024,
          limit: spec ? CLEF_DAILY_UNITS : JEV_DAILY_TOKEN_ALLOWANCE,
          rate: spec?.neuronsPerMillion ?? 1
        }
      ];
    });
    for (const [index, step] of steps.entries()) {
      if (signal.aborted) throw new ProviderFailure('cancelled', 0, attempts);
      const blocked = this.ledger.cooldown(step.key, this.now());
      const skip = !step.client
        ? 'missing-credentials'
        : (blocked ?? (this.now() + this.config.timeoutMs >= midnight ? 'utc-rollover' : undefined));
      if (skip) {
        record({ provider: step.provider, model: step.model, reason: skip, latencyMs: 0 });
        continue;
      }
      const client = step.client;
      if (!client) throw new Error('Decision provider missing');
      const remaining = deadline - Date.now();
      if (remaining <= 25) throw new ProviderFailure('timeout', 0, attempts);
      if (!this.ledger.reserve(day, step.key, step.reservation, step.limit)) {
        record({ provider: step.provider, model: step.model, reason: 'daily-budget', latencyMs: 0 });
        continue;
      }
      // A failed durable write must stop transport, rather than silently losing the reservation.
      await this.ledger.flush();
      if (signal.aborted) throw new ProviderFailure('cancelled', 0, attempts);
      const attempt: ProviderAttempt = {
        provider: step.provider,
        model: step.model,
        reason: 'in-flight',
        latencyMs: 0
      };
      record(attempt);
      const child = new AbortController();
      const abort = () => child.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, Math.floor((deadline - Date.now()) / (steps.length - index)) - 25));
      const started = Date.now();
      let cancelled: (() => void) | undefined;
      let result: ChoiceResult | undefined;
      let failure: ProviderFailure | undefined;
      try {
        const cancellation = new Promise<never>((_, reject) => {
          cancelled = () => reject(new ProviderFailure(signal.aborted ? 'cancelled' : 'timeout'));
          child.signal.addEventListener('abort', cancelled, { once: true });
        });
        result = await Promise.race([client.choose({ ...request, model: step.model }, child.signal), cancellation]);
      } catch (error) {
        failure = error instanceof ProviderFailure ? error : new ProviderFailure('provider-error');
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (cancelled) child.signal.removeEventListener('abort', cancelled);
        child.abort();
      }
      attempt.latencyMs = Date.now() - started;
      if (result) {
        this.ledger.adjust(day, step.key, result.inputTokens * step.rate - step.reservation);
        await this.ledger.flush();
        Object.assign(attempt, {
          reason: 'validated-choice',
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens
        });
        onAttempt?.(attempt);
        return { ...result, attempts };
      }
      const reason = failure?.code ?? 'provider-error';
      attempt.reason = reason;
      onAttempt?.(attempt);
      const until =
        reason === 'daily-neuron-quota' || ['http-401', 'http-403'].includes(reason)
          ? midnight
          : this.now() + Math.max(60000, failure?.retryAfterMs ?? 0);
      this.ledger.block(step.key, until, reason);
      await this.ledger.flush();
      if (signal.aborted) throw new ProviderFailure('cancelled', 0, attempts);
    }
    throw new ProviderFailure('providers-exhausted', 0, attempts);
  }
}
