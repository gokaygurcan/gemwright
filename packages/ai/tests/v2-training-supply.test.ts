import { expect, test } from 'bun:test';

import { spellbook } from '@gemwright/common/game/items';

import { spellNamed } from '../src/v1/spell-rules';
import { Mind } from '../src/v2/mind';
import { choices } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Mage', 'Tinker', 'Carpenter'] }] };
function pupil(supporting: string[], primary = ['Mining']) {
  const mind = new Mind('pupil', () => {}, traitsOf([], () => 0.5).traits, [], primary, supporting);
  const see = (kind: string, data: object) =>
    mind.observe({ resident: 'pupil', at: Date.now(), kind, data, where: { x: 10, y: 10, z: 0, map: 1 } });
  see('awake', {
    serial: 1,
    self: { health: { current: 100, max: 100 }, mana: { current: 100, max: 100 }, weight: { current: 10, max: 400 } },
    skills: { Mining: 60, Magery: 30, Tinkering: 20, Carpentry: 20, Inscribe: 20, Necromancy: 30 }
  });
  see('revealed', { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21, is: ['Backpack'] });
  see('revealed', { serial: 3, kind: 'item', graphic: 3821, amount: 2000, parent: 2, is: ['Gold'] });
  const plans = () => choices(mind, undefined, new Set(), places);
  return { mind, see, plans };
}

for (const skill of ['Magery', 'Tinkering', 'Carpentry', 'Inscribe', 'Necromancy']) {
  test(`${skill} practice prepares missing tools and supplies through executable purchases`, () => {
    const p = pupil([skill]);
    const plan = p.plans().find((o) => o.key.includes(skill));
    expect(plan).toBeDefined();
    expect(plan?.steps.some((s) => s.verb === 'buy')).toBe(true);
    expect(plan?.requiresGold).toBeGreaterThan(0);
  });
}

test('missing vendor-sold spells are learned from a purchased scroll rather than permanently disabled', () => {
  const p = pupil(['Magery']);
  p.see('revealed', { serial: 4, kind: 'item', graphic: spellbook, parent: 2, is: ['Spellbook'] });
  const cunning = spellNamed('Bless');
  p.see('spell-missing', { spell: spellNamed('Arch Protection').id });
  p.see('spell-missing', { spell: cunning.id });
  const plan = p.plans().find((o) => o.steps.some((s) => s.verb === 'buy' && s.graphic === cunning.scroll));
  expect(plan).toBeDefined();
});

test('supporting material already in the bank is withdrawn rather than bought again', () => {
  const p = pupil(['Tinkering']);
  p.see('revealed', { serial: 5, kind: 'item', graphic: 2475, parent: 1, layer: 29, is: ['BankBox'] });
  p.see('revealed', { serial: 6, kind: 'item', graphic: 7868, parent: 2, is: ['TinkersTools'] });
  p.see('revealed', {
    serial: 7,
    kind: 'item',
    graphic: 7154,
    amount: 100,
    parent: 5,
    is: ['IronIngot'],
    properties: [{ cliloc: 1072789, arguments: '10' }]
  });
  const plan = p.plans().find((o) => o.key.includes('Tinkering'));
  expect(plan?.steps.some((s) => s.verb === 'withdraw' && s.items.includes(7))).toBe(true);
  expect(plan?.steps.some((s) => s.verb === 'buy' && s.graphic === 7154)).toBe(false);
});

test('primary inscription practice is not lost when it is absent from supporting skills', () => {
  const p = pupil([], ['Magery', 'Inscribe']);
  expect(p.plans().some((o) => o.key.includes('Inscribe'))).toBe(true);
});
