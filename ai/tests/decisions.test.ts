import { expect, test } from 'bun:test';

import { type ChoiceRequest, ProviderFailure, parseChoice, validateDecisionConfig } from '../src/decision-provider';
import { DecisionCoordinator } from '../src/decisions';
import type { Checkpoint } from '../src/store';

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

test('an ambiguous request reserves budget before transport and keeps it after restarting', async () => {
  const cp = checkpoint();
  let requests = 0;
  const config = validateDecisionConfig({ provider: 'jev', maxDailyCostUsd: 0.003 });
  const provider = {
    choose: async () => {
      requests++;
      expect(cp.decisions?.budget.chargedInputTokens).toBe(65536);
      expect(cp.decisions?.history.at(-1)?.source).toBe('pending');
      throw new ProviderFailure('network-error');
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
  expect((await first.choose(options))?.id).toBe('mine');
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
