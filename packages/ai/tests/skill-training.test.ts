import { expect, test } from 'bun:test';

import { trainSupportingSkill } from '../src/skill-training';
import { behaviorFixture } from './behavior-fixture';

test('Arms Lore without an applicable target does not announce practice or send a skill request', async () => {
  const f = behaviorFixture();
  const phases: string[] = [];
  const logs: string[] = [];
  let requests = 0;
  f.session.useSkill = () => {
    requests++;
  };
  expect(
    await trainSupportingSkill({
      session: f.session,
      check: () => {},
      phase: (p) => phases.push(p),
      log: (m) => logs.push(m),
      items: () => [{ serial: 42, kind: 'item', graphic: 0xf39, parent: 10 }],
      until: Date.now() + 1000
    })
  ).toBe(0);
  expect(requests).toBe(0);
  expect(phases).toEqual([]);
  expect(logs).toEqual(['Cannot practise ArmsLore: no suitable observed target']);
});
