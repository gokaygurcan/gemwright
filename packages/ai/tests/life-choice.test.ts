import { expect, test } from 'bun:test';

import { Blocked } from '../src/blocked';
import { validateDecisionConfig } from '../src/decision-provider';
import { DecisionCoordinator } from '../src/decisions';
import { lifeTurn } from '../src/life';
import { chooseLifePhase, observeLifeWork } from '../src/life-choice';
import { tally, workEvidence } from '../src/work-evidence';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function fixture(selected: 'work' | 'dungeon') {
  const f = socialFixture('miner');
  f.template.behavior.activities = [];
  f.template.creation = { ...f.template.creation, city: 'Britain', skills: {} };
  f.world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xe85, parent: 10 });
  f.ctx.dungeon = async () => true;
  f.ctx.dungeonReady = () => true;
  f.ctx.decisions = new DecisionCoordinator(validateDecisionConfig({ provider: 'jev', minIntervalMs: 0 }), () => {}, {
    choose: async (request) => ({
      model: request.model,
      choice: selected,
      confidence: 1,
      probabilities: Object.fromEntries(
        Object.keys(request.questions.action.criteria).map((key) => [key, key === selected ? 1 : 0])
      ),
      inputTokens: 100,
      outputTokens: 1
    })
  });
  return f;
}

for (const outcome of ['completed', 'failed', 'blocked'] as const)
  test(`a life choice stays pending through execution and records ${outcome}`, async () => {
    const f = fixture('dungeon');
    const choice = await chooseLifePhase(f.ctx);
    const trace = required(f.checkpoint.decisions?.history.at(-1));
    expect(trace.execution.status).toBe('pending');
    f.checkpoint.life = { phase: choice.phase, until: Date.now() + 60_000, decision: choice.pick ?? undefined };
    f.ctx.dungeon = async () => {
      expect(trace.execution.status).toBe('pending');
      if (outcome === 'blocked') throw new Blocked('unreachable', 'Dungeon entrance blocked');
      return outcome === 'completed';
    };
    expect(await lifeTurn(f.ctx)).toBe(outcome === 'completed');
    expect(trace.execution.status).toBe(outcome === 'completed' ? 'completed' : 'failed');
    expect(f.checkpoint.life.decision).toBeUndefined();
  });

test('choosing work is completed only after a verified gain, not from movement or inventory churn', async () => {
  const f = fixture('work');
  const choice = await chooseLifePhase(f.ctx);
  f.checkpoint.life = {
    phase: 'work',
    until: Date.now() + 60_000,
    decision: choice.pick ?? undefined,
    before: workEvidence(f.session, f.checkpoint)
  };
  const trace = required(f.checkpoint.decisions?.history.at(-1));
  required(f.world.position).x++;
  f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x1bf2, parent: 10, amount: 20 });
  observeLifeWork(f.ctx);
  expect(trace.execution.status).toBe('pending');
  tally(f.session, 'mined');
  observeLifeWork(f.ctx);
  expect(trace.execution.status).toBe('completed');
});

test('a stale life choice cannot silently execute its random baseline', async () => {
  const f = fixture('dungeon');
  f.ctx.decisions = new DecisionCoordinator(validateDecisionConfig({ provider: 'jev', minIntervalMs: 0 }), () => {}, {
    choose: async (request) => {
      f.checkpoint.life = { phase: 'work', until: Date.now() + 60_000 };
      return {
        model: request.model,
        choice: 'dungeon',
        confidence: 1,
        probabilities: {},
        inputTokens: 100,
        outputTokens: 1
      };
    }
  });
  await expect(chooseLifePhase(f.ctx)).rejects.toThrow('stale');
  expect(f.checkpoint.decisions?.history.at(-1)?.execution.status).toBe('not-run');
  expect(f.checkpoint.life?.phase).toBe('work');
});
