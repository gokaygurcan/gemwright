import { expect, test } from 'bun:test';

import { canPause, urgentAction } from '../src/action-purpose';
import { commitmentConversation, commitmentTurn } from '../src/commitments';
import { companionInitiative } from '../src/companion-initiative';
import { registerCombat } from '../src/resident-context';
import { personalMemory, rememberPartner } from '../src/resident-memory';
import { hearPlanControl, planStopsFight, sharedPlanTurn } from '../src/shared-plans';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function planned() {
  const f = socialFixture('swordsman');
  f.world.position = { ...required(f.world.position), x: 1369, y: 1475 };
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    notoriety: 1,
    name: 'Ada',
    position: { ...required(f.world.position), x: 1370 }
  });
  f.world.partyMembers.add(2);
  registerCombat(f.session, { canFight: () => true, fight: async () => {} });
  const reply = commitmentConversation(f.session, 2, 'Ada', 'clear this cemetery, sell, then restock');
  return { ...f, reply, commitment: required(f.checkpoint.personal?.commitment) };
}

test('confirmed party companions can agree on a persistent multi-step plan', () => {
  const f = planned();
  expect(f.reply).toContain('split collected gold');
  expect(f.commitment.plan?.stage).toBe('prepare');
  const restored = JSON.parse(JSON.stringify(f.checkpoint));
  expect(personalMemory(restored).commitment?.plan?.groundName).toBe('Britain');
});

test('a shared plan executes the agreed town errands once and remembers completion afterwards', async () => {
  const f = planned();
  let errands = 0;
  f.ctx.errands = async () => {
    errands++;
  };
  await sharedPlanTurn(f.ctx, f.commitment);
  expect(f.commitment.plan?.stage).toBe('hunt');
  f.commitment.kills = 3;
  await sharedPlanTurn(f.ctx, f.commitment);
  expect(f.commitment.plan?.stage).toBe('settle');
  expect(f.checkpoint.personal?.episodes.some((e) => e.kind === 'plan')).toBe(false);
  f.world.entities.delete(2);
  await commitmentTurn(f.ctx);
  expect(errands).toBe(1);
  await commitmentTurn(f.ctx);
  expect(f.commitment.state).toBe('completed');
  expect(f.checkpoint.personal?.episodes.some((e) => e.kind === 'plan' && e.result === 'completed')).toBe(true);
  await commitmentTurn(f.ctx);
  expect(errands).toBe(1);
});

test('retreat, waiting and target vetoes are heard during combat only from the agreed partner', async () => {
  const f = planned();
  required(f.commitment.plan).stage = 'hunt';
  const entry = { serial: 2, name: 'Ada', text: 'wait here', at: new Date().toISOString(), party: true };
  expect(hearPlanControl(f.session, { ...entry, serial: 3 })).toBe(false);
  await urgentAction(f.session, 'combat', async () => {
    expect(hearPlanControl(f.session, entry)).toBe(true);
    expect(canPause(f.session)).toBe(false);
    expect(planStopsFight(f.session, 3)).toBe(true);
  });
  expect(hearPlanControl(f.session, { ...entry, text: 'continue' })).toBe(true);
  expect(planStopsFight(f.session, 3)).toBe(false);
  f.world.combatant = 3;
  hearPlanControl(f.session, { ...entry, text: 'leave that one' });
  expect(planStopsFight(f.session, 3)).toBe(true);
  expect(planStopsFight(f.session, 4)).toBe(false);
  hearPlanControl(f.session, { ...entry, text: "we're leaving" });
  expect(f.commitment.plan?.stage).toBe('settle');
  expect(f.spoken).toHaveLength(0);
});

test('an unfinished plan timing out is recorded as an interruption, not a success', async () => {
  const f = planned();
  f.commitment.until = Date.now() - 1;
  await commitmentTurn(f.ctx);
  expect(f.commitment.state).toBe('cancelled');
  expect(f.checkpoint.personal?.episodes.at(-1)?.result).toBe('interrupted');
});

test('familiarity can prompt a new invitation but cannot divert an active agreement', () => {
  const f = planned();
  for (let i = 0; i < 4; i++)
    rememberPartner(f.checkpoint, {
      partner: 2,
      name: 'Ada',
      kind: 'outing',
      result: 'completed',
      detail: 'Hunted together',
      id: `prior:${i}`
    });
  expect(companionInitiative(f.ctx)).toBe(false);
  f.commitment.state = 'completed';
  expect(companionInitiative(f.ctx)).toBe(true);
  expect(f.spoken[0]).toContain('ask me to hunt together');
  expect(companionInitiative(f.ctx)).toBe(false);
  expect(f.commitment.state).toBe('completed');
});
