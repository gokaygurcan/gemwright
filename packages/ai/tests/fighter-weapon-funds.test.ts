import { expect, spyOn, test } from 'bun:test';

import * as bankGold from '../src/bank-gold';
import { createFighterEquipment } from '../src/fighter-equipment';
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
