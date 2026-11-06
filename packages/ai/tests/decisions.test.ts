import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { JEV_RESIDENT_TOKEN_ALLOWANCE } from '../src/decision-jev';
import { DecisionLog } from '../src/decision-log';
import { type ChoiceRequest, pacedAllowance, parseChoice, validateDecisionConfig } from '../src/decision-provider';
import { DecisionCoordinator, OPTIONAL_KINDS, OPTIONAL_SHARE, reservedTokens } from '../src/decisions';
import type { Checkpoint } from '../src/store';
import { required } from './behavior-fixture';

const checkpoint = (): Checkpoint => ({ goal: null, memories: [], relationships: {} });
const candidates = [
  { id: 'mine', description: 'Mine', valid: () => true },
  { id: 'bank', description: 'Bank', valid: () => true }
];
const result = {
  model: 'jev-1.13.0',
  choice: 'bank',
  confidence: 0.9,
  probabilities: { mine: 0.1, bank: 0.9 },
  inputTokens: 100,
  outputTokens: 10
};
const request: ChoiceRequest = {
  model: 'jev-1.13.0',
  state: {},
  questions: { action: { type: 'choice', instructions: 'Choose', criteria: { mine: 'Mine', bank: 'Bank' } } }
};

test('provider response cannot invent an action or omit a candidate probability', () => {
  const wire = {
    model: result.model,
    answers: { action: { type: 'choice', choice: 'bank', confidence: 0.9, probabilities: result.probabilities } },
    usage: { input_tokens: 100, output_tokens: 10 }
  };
  expect(parseChoice(wire, request).choice).toBe('bank');
  expect(() =>
    parseChoice({ ...wire, answers: { action: { ...wire.answers.action, choice: 'teleport' } } }, request)
  ).toThrow();
  expect(() =>
    parseChoice({ ...wire, answers: { action: { ...wire.answers.action, probabilities: { bank: 1 } } } }, request)
  ).toThrow();
});

test('a late model answer cannot execute after its observations changed', async () => {
  const cp = checkpoint();
  let current = true;
  const service = new DecisionCoordinator(validateDecisionConfig({ provider: 'jev', timeoutMs: 100 }), () => {}, {
    choose: async () => {
      current = false;
      return result;
    }
  });
  const pick = await service.choose({
    kind: 'activity',
    checkpoint: cp,
    state: {},
    observationRevision: 1,
    candidates,
    baseline: 'mine',
    stillCurrent: () => current
  });
  expect(pick).toBeNull();
  expect(cp.decisions?.history.at(-1)?.source).toBe('stale');
  expect(cp.decisions?.history.at(-1)?.execution.status).toBe('not-run');
});

test('a request reserves budget before transport, and a successful call keeps it after restarting', async () => {
  const cp = checkpoint();
  let requests = 0;
  let charged = 0;
  const config = validateDecisionConfig({ provider: 'jev' });
  const provider = {
    choose: async () => {
      requests++;
      charged = cp.decisions?.budget.chargedInputTokens ?? 0;
      expect(cp.decisions?.history.at(-1)?.source).toBe('pending');
      // A real call that used most of the day's allowance: the next one must be refused.
      return { ...result, inputTokens: JEV_RESIDENT_TOKEN_ALLOWANCE, outputTokens: 0 };
    }
  };
  const options = {
    kind: 'activity',
    checkpoint: cp,
    state: {},
    observationRevision: 1,
    candidates,
    baseline: 'mine',
    stillCurrent: () => true
  };
  const first = new DecisionCoordinator(config, () => {}, provider);
  expect((await first.choose(options))?.id).toBe('bank');
  // Reserved before transport, and it is the request's own size, not a flat sixty-five thousand.
  expect(charged).toBeGreaterThan(0);
  expect(charged).toBeLessThan(65536);
  const reopened = JSON.parse(JSON.stringify(cp)) as Checkpoint;
  const next = new DecisionCoordinator(config, () => {}, provider);
  next.reconcile(reopened);
  expect(reopened.decisions?.history[0]?.execution.status).toBe('interrupted');
  expect((await next.choose({ ...options, checkpoint: reopened }))?.id).toBe('mine');
  expect(requests).toBe(1);
  expect(reopened.decisions?.history.at(-1)?.reason).toBe('daily-cost-budget');
});

test('the provider is benched for a kind only when its divergent choices underperform', async () => {
  const { underperforms } = await import('../src/decisions');
  // Agreeing choices: 80 completed, 5 failed (94%). The divergent counts are added on top.
  const tally = (divergent: number, completed: number, failed: number) => ({
    decisions: 85 + divergent,
    divergent,
    outcomes: { completed: 80 + completed, failed: 5 + failed },
    divergentOutcomes: { completed, failed }
  });
  expect(underperforms(undefined)).toBe(false);
  expect(underperforms(tally(10, 2, 8))).toBe(false);
  expect(underperforms(tally(25, 10, 15))).toBe(true);
  expect(underperforms(tally(25, 23, 2))).toBe(false);
});

test('every decision receives planner context and a changed intention invalidates an in-flight answer', async () => {
  const { chooseGoal, blockGoal } = await import('../src/resident-goal');
  const { personalMemory } = await import('../src/resident-memory');
  const cp = checkpoint();
  personalMemory(cp).goals.push({
    id: 'saving',
    kind: 'mount',
    description: 'Save for a horse',
    progress: 100,
    target: 1000,
    startedAt: Date.now(),
    state: 'active'
  });
  const state = {
    safe: true,
    ready: true,
    learning: false,
    earningNeeded: true,
    evidence: { funds: 100, bankKnown: true, gold: 100, skills: {}, products: 0, orders: 0, goods: 0, health: 100 }
  };
  cp.workGoal = {
    failed: { 'order:old': { until: Date.now() + 60_000, reason: 'Vendor unavailable' } },
    outcomes: [
      {
        id: 'old',
        key: 'order:old',
        kind: 'order',
        condition: 'previous-location',
        at: Date.now(),
        result: 'blocked',
        reason: 'Vendor unavailable',
        wealth: null,
        capability: null
      }
    ]
  };
  const goal = chooseGoal(cp, state);
  const service = new DecisionCoordinator(validateDecisionConfig({ provider: 'jev' }), () => {}, {
    choose: async (request) => {
      expect(request.state).toMatchObject({
        callerSpecific: 'combat',
        planning: {
          active: { id: goal.intent?.id, kind: 'earn', step: 'trade' },
          personalGoal: { id: 'saving' },
          failures: [{ key: 'order:old', reason: 'Vendor unavailable' }],
          outcomes: [{ key: 'order:old', result: 'blocked' }]
        }
      });
      blockGoal(cp, 'Customer cancelled while deciding', Date.now(), state);
      return result;
    }
  });
  const pick = await service.choose({
    kind: 'activity',
    checkpoint: cp,
    state: { callerSpecific: 'combat' },
    observationRevision: 1,
    candidates,
    baseline: 'mine',
    stillCurrent: () => true
  });
  expect(pick).toBeNull();
  expect(cp.decisions?.history.at(-1)?.execution.status).toBe('not-run');
  expect(cp.decisions?.tally).toBeUndefined();
});

test('a request reserves its own size, not sixty-five thousand tokens', () => {
  // 12 KB is the request cap: about 3k tokens, not 65k. The flat reservation was twenty times the
  // real cost, so fifty-odd calls spent the town's whole day.
  expect(reservedTokens(12000)).toBe(3750);
  expect(reservedTokens(12000)).toBeLessThan(65536);
  expect(reservedTokens(0)).toBe(0);
});

test('the population budget is paced across the UTC day', () => {
  const start = Date.UTC(2026, 0, 1, 0, 0);
  expect(pacedAllowance(1, start)).toBeCloseTo(0.1, 2);
  expect(pacedAllowance(1, start + 12 * 3_600_000)).toBeCloseTo(0.6, 2);
  expect(pacedAllowance(1, start + 23 * 3_600_000)).toBeCloseTo(1, 2);
  expect(OPTIONAL_KINDS.has('speech-reply')).toBe(true);
  expect(OPTIONAL_KINDS.has('life-phase')).toBe(false);
  expect(OPTIONAL_SHARE).toBe(0.4);
});

test('a failed provider call gives its reservation back', async () => {
  const cp = checkpoint();
  let spent = 0;
  const ledger = { tokens: () => spent, add: (_day: string, delta: number) => (spent += delta) };
  const service = new DecisionCoordinator(
    validateDecisionConfig({ provider: 'jev', timeoutMs: 100 }),
    () => {},
    {
      choose: async () => {
        throw new Error('provider down');
      }
    },
    ledger as never
  );
  const pick = await service.choose({
    kind: 'life-phase',
    checkpoint: cp,
    state: { sample: 'small' },
    observationRevision: 1,
    candidates,
    baseline: 'mine',
    stillCurrent: () => true
  });
  expect(pick?.id).toBe('mine');
  expect(spent).toBe(0);
});

test('every settled question is logged with its request and the answer, model or local', async () => {
  const db = new Database(':memory:');
  const log = new DecisionLog(db);
  const options = {
    kind: 'activity',
    checkpoint: checkpoint(),
    state: { health: 90 },
    observationRevision: 1,
    candidates,
    baseline: 'mine',
    stillCurrent: () => true
  };
  const answered = {
    ...result,
    attempts: [
      {
        provider: 'jev' as const,
        model: 'jev-1.13.0',
        reason: 'validated-choice',
        latencyMs: 5,
        wire: { url: 'https://jev', sent: '{"q":1}', status: 200, received: '{"a":1}' }
      }
    ]
  };
  const model = new DecisionCoordinator(
    validateDecisionConfig({ provider: 'jev' }),
    () => {},
    { choose: async () => answered },
    undefined,
    (trace, request, exchanges) => log.record('r1', trace, request, exchanges)
  );
  await model.choose(options);
  const local = new DecisionCoordinator(
    validateDecisionConfig({ provider: 'local' }),
    () => {},
    undefined,
    undefined,
    (trace, request, exchanges) => log.record('r1', trace, request, exchanges)
  );
  await local.choose({ ...options, checkpoint: checkpoint() });
  const rows = db
    .query<
      { provider: string; selected: string; request: Uint8Array<ArrayBuffer>; response: Uint8Array<ArrayBuffer> },
      []
    >('SELECT provider, selected, request, response FROM decision_log ORDER BY provider')
    .all();
  expect(rows.map((row) => [row.provider, row.selected])).toEqual([
    ['jev', 'bank'],
    ['local', 'mine']
  ]);
  const asked = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(required(rows[0]).request)));
  expect(asked.state.health).toBe(90);
  expect(asked.questions.action.criteria).toEqual({ mine: 'Mine', bank: 'Bank' });
  expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(required(rows[0]).response))).probabilities).toEqual(
    result.probabilities
  );
  // The exact exchange is in the log, not in the checkpoint (it would bloat every save).
  const logged = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(required(rows[0]).response)));
  expect(logged.attempts[0].wire.sent).toBe('{"q":1}');
  expect(JSON.stringify(options.checkpoint.decisions)).not.toContain('"wire"');
});
