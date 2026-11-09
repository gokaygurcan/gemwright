import { expect, spyOn, test } from 'bun:test';

import * as bankGold from '../src/bank-gold';
import { createFighterEquipment } from '../src/fighter-equipment';
import { gearCheckDue } from '../src/fighter-gear';
import { fighterFixture } from './fighter-fixture';

// Dunstan Miller, Nov 6: 125 gold in the bank, a balance older than a quarter hour that counted as
// nothing, so every smith's price looked too high and the weaponless fighter bought nothing.
test('a weaponless fighter with a stale bank balance asks for it before shopping for a weapon', async () => {
  const f = fighterFixture();
  f.checkpoint.funds = { bank: 125, at: Date.now() - 3_600_000 };
  f.checkpoint.bankLookAfter = Date.now() + 3_600_000;
  const refreshed = spyOn(bankGold, 'refreshFunds').mockImplementation(async () => {});
  try {
    const equipment = createFighterEquipment(f.ctx, {
      contextAction: async () => false,
      openBank: async () => undefined,
      restock: async () => {}
    });
    await equipment.prepareEquipment().catch(() => {});
    expect(refreshed).toHaveBeenCalled();
  } finally {
    refreshed.mockRestore();
  }
});

// Finn Gray, Nov 9: thousands in the bank, a balance gone stale, and armor shopping returned
// without a word: armed and rich, he never bought a piece.
test('an armed fighter with a stale bank balance asks for it before shopping for armor', async () => {
  const f = fighterFixture();
  f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0xf61, parent: 1, layer: 1 });
  f.checkpoint.funds = { bank: 13_000, at: Date.now() - 3_600_000 };
  const refreshed = spyOn(bankGold, 'refreshFunds').mockImplementation(async () => {});
  try {
    const equipment = createFighterEquipment(f.ctx, {
      contextAction: async () => false,
      openBank: async () => undefined,
      restock: async () => {}
    });
    await equipment.prepareEquipment().catch(() => {});
    expect(refreshed).toHaveBeenCalled();
  } finally {
    refreshed.mockRestore();
  }
});

// Finn Gray, Nov 9: armor was only looked for after a finished hunt, and he seldom finished one.
// Leaving town with money to spare is reason enough, at most every half hour.
test('a gear check is due on leaving town with money to spare, not only after a hunt', () => {
  expect(gearCheckDue(13_000, 0, Date.now())).toBe(true);
  expect(gearCheckDue(13_000, Date.now() - 60_000, Date.now())).toBe(false);
  expect(gearCheckDue(300, 0, Date.now())).toBe(false);
});
