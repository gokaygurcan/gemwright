import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DecisionChain } from '../src/decision-chain';
import { CLEF_DAILY_UNITS, CLEF_MODELS, ClefProvider } from '../src/decision-clef';
import { JEV_DAILY_TOKEN_ALLOWANCE } from '../src/decision-jev';
import {
  type ChoiceRequest,
  type DecisionProvider,
  ProviderFailure,
  validateDecisionConfig
} from '../src/decision-provider';
import { DecisionCoordinator } from '../src/decisions';
import { SpendLedger } from '../src/spend-ledger';
import type { Checkpoint } from '../src/store';

const accountId = 'a'.repeat(32);
const request: ChoiceRequest = {
  model: 'clef-flash',
  state: { health: 100 },
  questions: { action: { type: 'choice', instructions: 'Choose', criteria: { work: 'Work', bank: 'Bank' } } }
};
const answer = (model = 'clef-flash') => ({
  model,
  choice: 'bank',
  confidence: 0.9,
  probabilities: { work: 0.1, bank: 0.9 },
  inputTokens: 100,
  outputTokens: 0
});
const wire = () => ({
  success: true,
  result: {
    model: 'clef-flash',
    answers: { action: { type: 'choice', choice: 'bank', confidence: 0.9, probabilities: { work: 0.1, bank: 0.9 } } },
    usage: { input_tokens: 100, output_tokens: 0 }
  }
});
const provider: DecisionProvider = { choose: async (request) => answer(request.model) };
// Late in the UTC day the paced allowance is the whole day's.
const late = () => Date.parse(`${new Date().toISOString().slice(0, 10)}T22:00:00Z`);
const setup = (overrides = {}) => {
  const db = new Database(':memory:');
  const ledger = new SpendLedger(db);
  const config = validateDecisionConfig({
    providers: [
      { provider: 'clef', model: 'clef-flash' },
      { provider: 'jev', model: 'jev-1.13.0' },
      { provider: 'local' }
    ],
    minIntervalMs: 0,
    ...overrides
  });
  return { db, ledger, config };
};

test('provider configuration selects models without exposing budget controls', () => {
  const config = validateDecisionConfig({ provider: 'clef' });
  expect(config.providers[0]?.provider === 'local' ? undefined : config.providers[0]?.model).toBe('clef-flash');
  expect(config.providers[0]).toMatchObject({ provider: 'clef', model: 'clef-flash' });
  expect(() =>
    validateDecisionConfig({
      providers: [{ provider: 'clef', model: 'clef-flash', budget: 1 }, { provider: 'local' }]
    })
  ).toThrow();
  expect(() => validateDecisionConfig({ provider: 'clef', model: 'jev-1.13.0' })).toThrow();
});

test('Clef REST adapter uses the fixed endpoint, supplied choices, and validates the envelope', async () => {
  const client = new ClefProvider(accountId, 'test-token', async (url, init) => {
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`);
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(init?.body as string)).toEqual(request);
    return Response.json(wire());
  });
  expect(await client.choose(request, new AbortController().signal)).toEqual(answer());
  const invalid = wire();
  invalid.result.answers.action.choice = 'teleport';
  const bad = new ClefProvider(accountId, 'test-token', async () => Response.json(invalid));
  await expect(bad.choose(request, new AbortController().signal)).rejects.toThrow('invalid-response');
});

test('daily quota errors differ from temporary rate limits', async () => {
  for (const [code, expected] of [
    [3036, 'daily-neuron-quota'],
    [3040, 'http-429']
  ] as const) {
    const client = new ClefProvider(accountId, 'test-token', async () =>
      Response.json({ success: false, errors: [{ code }] }, { status: 429 })
    );
    await expect(client.choose(request, new AbortController().signal)).rejects.toThrow(expected);
  }
});

test('Clef succeeds first without spending Jev budget', async () => {
  const { db, ledger, config } = setup();
  let jev = 0;
  const chain = new DecisionChain(config, ledger, {
    clef: provider,
    accountId,
    jev: {
      choose: async () => {
        jev++;
        return answer('jev-1.13.0');
      }
    }
  });
  const result = await chain.choose(request, new AbortController().signal);
  const day = new Date().toISOString().slice(0, 10);
  expect(result.model).toBe('clef-flash');
  expect(jev).toBe(0);
  expect(ledger.units(day, `cloudflare:${accountId}`)).toBe(100 * CLEF_MODELS['clef-flash'].neuronsPerMillion);
  expect(ledger.tokens(day)).toBe(0);
  db.close();
});

test('exhausted Clef advances to Jev; exhausting both produces a local decision with reasons', async () => {
  const { db, ledger, config } = setup({
    providers: [
      { provider: 'clef', model: 'clef-flash' },
      { provider: 'jev', model: 'jev-1.13.0' },
      { provider: 'local' }
    ]
  });
  const day = new Date().toISOString().slice(0, 10);
  ledger.adjust(day, `cloudflare:${accountId}`, CLEF_DAILY_UNITS);
  const cp: Checkpoint = { goal: null, memories: [], relationships: {} };
  const options = {
    kind: 'activity',
    checkpoint: cp,
    state: {},
    observationRevision: 1,
    baseline: 'work',
    stillCurrent: () => true,
    candidates: [
      { id: 'work', description: 'Work', valid: () => true },
      { id: 'bank', description: 'Bank', valid: () => true }
    ]
  };
  let clef = 0;
  const clients = {
    accountId,
    clef: {
      choose: async () => {
        clef++;
        return answer();
      }
    },
    jev: provider
  };
  const chain = new DecisionChain(config, ledger, clients);
  const coordinator = new DecisionCoordinator(config, () => {}, chain, ledger);
  expect((await coordinator.choose(options))?.id).toBe('bank');
  expect(clef).toBe(0);
  expect(cp.decisions?.history.at(-1)?.resolvedModel).toBe('jev-1.13.0');
  expect(cp.decisions?.history.at(-1)?.attempts?.map((a) => a.reason)).toEqual(['daily-budget', 'validated-choice']);
  ledger.add(day, JEV_DAILY_TOKEN_ALLOWANCE - ledger.tokens(day));
  const local = new DecisionCoordinator(config, () => {}, new DecisionChain(config, ledger, clients), ledger);
  expect((await local.choose(options))?.id).toBe('work');
  expect(cp.decisions?.history.at(-1)?.reason).toBe('providers-exhausted');
  expect(cp.decisions?.history.at(-1)?.attempts?.map((a) => a.reason)).toEqual(['daily-budget', 'daily-budget']);
  db.close();
});

test('concurrent residents reserve before transport and share the same persistent allowance', async () => {
  const { db, ledger, config } = setup({
    providers: [
      { provider: 'clef', model: 'clef-flash' },
      { provider: 'jev', model: 'jev-1.13.0' },
      { provider: 'local' }
    ]
  });
  ledger.adjust(new Date().toISOString().slice(0, 10), `cloudflare:${accountId}`, CLEF_DAILY_UNITS - 100 * 1000000);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const clef = {
    choose: async () => {
      calls++;
      await waiting;
      return answer();
    }
  };
  const first = new DecisionChain(config, ledger, { clef, jev: provider, accountId }, late);
  const pending = first.choose(request, new AbortController().signal);
  await Promise.resolve();
  const restartedLedger = new SpendLedger(db);
  const second = new DecisionChain(config, restartedLedger, { clef, jev: provider, accountId }, late);
  expect((await second.choose(request, new AbortController().signal)).model).toBe('jev-1.13.0');
  expect(calls).toBe(1);
  release();
  expect((await pending).model).toBe('clef-flash');
  db.close();
});

test('uncertain charges remain reserved across provider failure and reconstruction', async () => {
  const { db, ledger, config } = setup();
  let calls = 0;
  const clef = {
    choose: async () => {
      calls++;
      throw new ProviderFailure('network-error');
    }
  };
  const chain = new DecisionChain(config, ledger, { clef, jev: provider, accountId });
  expect((await chain.choose(request, new AbortController().signal)).model).toBe('jev-1.13.0');
  const day = new Date().toISOString().slice(0, 10);
  expect(ledger.units(day, `cloudflare:${accountId}`)).toBe(
    CLEF_MODELS['clef-flash'].context * CLEF_MODELS['clef-flash'].neuronsPerMillion
  );
  const reopened = new DecisionChain(config, new SpendLedger(db), { clef, jev: provider, accountId });
  await reopened.choose(request, new AbortController().signal);
  expect(calls).toBe(1);
  db.close();
});

test('quota exhaustion is remembered until UTC reset and old reservations remain on their original day', async () => {
  const { db, ledger, config } = setup();
  let now = Date.UTC(2026, 0, 1, 12);
  let calls = 0;
  const clef = {
    choose: async () => {
      calls++;
      if (calls === 1) throw new ProviderFailure('daily-neuron-quota');
      return answer();
    }
  };
  const create = () => new DecisionChain(config, new SpendLedger(db), { clef, jev: provider, accountId }, () => now);
  expect((await create().choose(request, new AbortController().signal)).model).toBe('jev-1.13.0');
  await create().choose(request, new AbortController().signal);
  expect(calls).toBe(1);
  now += 86400000;
  expect((await create().choose(request, new AbortController().signal)).model).toBe('clef-flash');
  expect(calls).toBe(2);
  expect(ledger.units('2026-01-01', `cloudflare:${accountId}`)).toBeGreaterThan(
    ledger.units('2026-01-02', `cloudflare:${accountId}`)
  );
  db.close();
});

test('Clef timeout leaves time for Jev, and cancellation prevents trying the next provider', async () => {
  const { db, ledger, config } = setup({ timeoutMs: 200 });
  const hangs = { choose: () => new Promise<never>(() => {}) };
  const chain = new DecisionChain(config, ledger, { clef: hangs, jev: provider, accountId });
  const result = await chain.choose(request, new AbortController().signal);
  expect(result.model).toBe('jev-1.13.0');
  expect(result.attempts?.[0]?.reason).toBe('timeout');
  const controller = new AbortController();
  controller.abort();
  await expect(chain.choose(request, controller.signal)).rejects.toThrow('cancelled');
  db.close();
});

test('reservations must be durable before making a billed request', async () => {
  const { db, config } = setup();
  const ledger = new SpendLedger(db, async () => {
    throw new Error('storage unavailable');
  });
  let calls = 0;
  const clef = {
    choose: async () => {
      calls++;
      return answer();
    }
  };
  await expect(
    new DecisionChain(config, ledger, { clef, accountId }).choose(request, new AbortController().signal)
  ).rejects.toThrow('storage unavailable');
  expect(calls).toBe(0);
  db.close();
});

test('provider order and model selection come from the configured list', async () => {
  const { db, ledger, config } = setup({
    providers: [
      { provider: 'jev', model: 'jev-1.14.0' },
      { provider: 'clef', model: 'clef-omni' },
      { provider: 'local' }
    ]
  });
  const calls: string[] = [];
  const jev = {
    choose: async (request: ChoiceRequest) => {
      calls.push(request.model);
      throw new ProviderFailure('http-503');
    }
  };
  const clef = {
    choose: async (request: ChoiceRequest) => {
      calls.push(request.model);
      return answer(request.model);
    }
  };
  const result = await new DecisionChain(config, ledger, { jev, clef, accountId }).choose(
    request,
    new AbortController().signal
  );
  expect(calls).toEqual(['jev-1.14.0', 'clef-omni']);
  expect(result.model).toBe('clef-omni');
  db.close();
});

test('spend and cooldown survive closing and reopening the database', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gemwright-clef-ledger-'));
  const path = join(folder, 'residents.sqlite');
  try {
    const db = new Database(path);
    const ledger = new SpendLedger(db);
    ledger.reserve('2026-01-01', `cloudflare:${accountId}`, 100, 100);
    ledger.block(`cloudflare:${accountId}`, 1000, 'daily-neuron-quota');
    ledger.add('2026-01-01', 200);
    db.close();
    const reopened = new Database(path);
    const saved = new SpendLedger(reopened);
    expect(saved.units('2026-01-01', `cloudflare:${accountId}`)).toBe(100);
    expect(saved.reserve('2026-01-01', `cloudflare:${accountId}`, 1, 100)).toBe(false);
    expect(saved.cooldown(`cloudflare:${accountId}`, 500)).toBe('daily-neuron-quota');
    expect(saved.tokens('2026-01-01')).toBe(200);
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fifty simultaneous residents cannot oversubscribe a daily budget', async () => {
  const { db, ledger, config } = setup({
    providers: [{ provider: 'clef', model: 'clef-flash' }, { provider: 'local' }]
  });
  ledger.adjust(new Date().toISOString().slice(0, 10), `cloudflare:${accountId}`, CLEF_DAILY_UNITS - 100 * 1000000);
  let calls = 0;
  const clef = {
    choose: async () => {
      calls++;
      return answer();
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () =>
      new DecisionChain(config, ledger, { clef, accountId }, late).choose(request, new AbortController().signal)
    )
  );
  expect(calls).toBe(1);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(ledger.units(new Date().toISOString().slice(0, 10), `cloudflare:${accountId}`)).toBeLessThanOrEqual(
    CLEF_DAILY_UNITS
  );
  db.close();
});

test('a changed observation during Clef failure never launches Jev', async () => {
  const { db, ledger, config } = setup({ timeoutMs: 200 });
  let current = true;
  let jev = 0;
  const chain = new DecisionChain(config, ledger, {
    accountId,
    clef: {
      choose: () =>
        new Promise(() => {
          setTimeout(() => {
            current = false;
          }, 5);
        })
    },
    jev: {
      choose: async () => {
        jev++;
        return answer('jev-1.13.0');
      }
    }
  });
  const cp: Checkpoint = { goal: null, memories: [], relationships: {} };
  const coordinator = new DecisionCoordinator(config, () => {}, chain, ledger);
  const result = await coordinator.choose({
    kind: 'activity',
    checkpoint: cp,
    state: {},
    observationRevision: 1,
    baseline: 'work',
    stillCurrent: () => current,
    candidates: [
      { id: 'work', description: 'Work', valid: () => true },
      { id: 'bank', description: 'Bank', valid: () => true }
    ]
  });
  expect(result).toBeNull();
  expect(jev).toBe(0);
  expect(cp.decisions?.history.at(-1)?.source).toBe('stale');
  expect(cp.decisions?.history.at(-1)?.attempts?.[0]?.provider).toBe('clef');
  await new Promise((resolve) => setTimeout(resolve, 1));
  db.close();
});

test('missing Jev credentials preserve local decisions without failing resident startup', async () => {
  const credentialEnv = `GEMWRIGHT_TEST_${crypto.randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const config = validateDecisionConfig({
    providers: [{ provider: 'jev', model: 'jev-1.13.0', credentialEnv }, { provider: 'local' }]
  });
  const cp: Checkpoint = { goal: null, memories: [], relationships: {} };
  const coordinator = new DecisionCoordinator(config, () => {});
  expect(
    (
      await coordinator.choose({
        kind: 'activity',
        checkpoint: cp,
        state: {},
        observationRevision: 1,
        baseline: 'work',
        stillCurrent: () => true,
        candidates: [
          { id: 'work', description: 'Work', valid: () => true },
          { id: 'bank', description: 'Bank', valid: () => true }
        ]
      })
    )?.id
  ).toBe('work');
  expect(cp.decisions?.history.at(-1)?.source).toBe('local');
});

test('the daily allowance is paced across the UTC day, not spent at the first opportunity', async () => {
  const { db, ledger, config } = setup();
  const day = new Date().toISOString().slice(0, 10);
  const morning = Date.parse(`${day}T06:00:00Z`);
  ledger.adjust(day, `cloudflare:${accountId}`, CLEF_DAILY_UNITS / 2);
  let clef = 0;
  const chain = new DecisionChain(
    config,
    ledger,
    {
      clef: {
        choose: async () => {
          clef++;
          return answer();
        }
      },
      jev: provider,
      accountId
    },
    () => morning
  );
  const result = await chain.choose(request, new AbortController().signal);
  expect(clef).toBe(0);
  expect(result.model).toBe('jev-1.13.0');
  expect(result.attempts?.[0]?.reason).toBe('daily-budget');
  db.close();
});
