import { board, logPile } from '@gemwright/common/game/items';
import type { Entity } from '@gemwright/network/world';

import { replaceDeathRobe } from './death-robe';
import { pickLocation } from './locations';
import { sellBoards, storeAtBank } from './lumber-sell';
import { buyHatchetFrom } from './lumber-shop';
import type { MountContext } from './mount-types';
import type { createPackAnimal } from './pack-animal';
import { onItem, useOn } from './target-action';

const log = logPile;
const woodSet = new Set([board]);

// The lumberjack's town trip (lumberjack.ts): logs cut into boards, boards sold to residents and
// the carpenter, the earnings and unsold wood banked, a broken hatchet replaced.
export type LumberTown = Pick<
  MountContext,
  'session' | 'serial' | 'terrain' | 'position' | 'navigate' | 'check' | 'phase' | 'checkpoint' | 'status'
> & {
  city: string;
  progress: { boards: number; sold: number; earned: number; trips: number };
  say: (message: string) => void;
  carried: () => Entity[];
  count: (graphic: number) => number;
  tool: () => Entity | undefined;
  heavy: () => boolean;
  practise: (only?: string) => Promise<unknown>;
  backpackSerial: () => number;
  packs: () => ReturnType<typeof createPackAnimal> | undefined;
};

export function createLumberTown(t: LumberTown) {
  const { session, serial, terrain, city, checkpoint, progress, position, status, navigate, check } = t;
  const { phase, say, carried, count, tool, heavy, practise, backpackSerial } = t;
  const cutBoards = async () => {
    const pile = carried().find((item) => item.graphic === log && !item.hue);
    const axe = tool();
    if (!pile || !axe) return;
    phase('cutting-boards', `Cutting ${pile.amount ?? 1} logs into boards`);
    const before = count(board);
    const cut = await useOn(session, () => session.use(axe.serial), onItem(pile), {
      label: 'hatchet cursor',
      ms: 4000
    });
    if ('why' in cut) {
      say(`The hatchet would not cut the logs (${cut.why})`);
      return;
    }
    await session.waitFor(() => count(board) > before || !session.world.entities.has(pile.serial), 'boards', 5000);
    progress.boards += count(board) - before;
  };

  // Town trip: sell boards to the carpenter, bank the gold, replace a broken hatchet.
  const town = async () => {
    await cutBoards();
    await replaceDeathRobe({
      ...{ session, serial, terrain, position, navigate, check, phase, log: say, checkpoint, status, city },
      carried: (pack: number) => session.world.childrenOf(pack),
      backpack: backpackSerial
    });
    // Occasionally craft furniture before selling the boards.
    if (checkpoint.workGoal?.active?.kind === 'learn' && count(board) >= 50 && Math.random() < 0.25)
      await practise('Carpentry');
    const carpenter = pickLocation(city, 'carpenter');
    // Pack animal boards sell a load at a time.
    const room = () => status().maxWeight - 20 - status().weight;
    for (let load = 0; load < 20; load++) {
      if (carpenter && count(board) > 0) {
        phase('selling', `Taking ${count(board)} boards to the carpenter`);
        await navigate(carpenter, 4);
        const sold = await sellBoards({
          session,
          terrain,
          position,
          navigate,
          check,
          serial,
          status,
          backpack: backpackSerial
        });
        if (sold) {
          progress.sold += sold.amount;
          progress.earned += sold.earned;
          phase('sold', `Sold boards for ${sold.earned} gold`);
        }
      }
      if (!(await t.packs()?.unload(woodSet, 1, room))) break;
    }
    const bank = pickLocation(city, 'banker');
    // Boards no carpenter bought would keep the pack at its limit; a player stores them in the bank.
    if (bank && (status().gold > 0 || heavy())) {
      phase('bank-travel', heavy() ? 'Storing unsold wood and banking the earnings' : 'Banking the earnings');
      await navigate(bank, 4);
      await storeAtBank(
        { session, serial, position, terrain, navigate, check, checkpoint, carried, phase },
        heavy() ? [board, log] : []
      );
    }
    if (!tool()) await buyHatchet();
    await t.packs()?.acquire();
    progress.trips++;
  };

  const buyHatchet = () =>
    buyHatchetFrom({
      session,
      terrain,
      position,
      navigate,
      check,
      serial,
      phase,
      checkpoint,
      city,
      backpack: backpackSerial
    });

  return { cutBoards, town, buyHatchet };
}
