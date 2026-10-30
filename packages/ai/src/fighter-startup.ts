import { Layer } from '@gemwright/network/layers';
import { Opcode } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';

import type { FighterContext } from './fighter-context';

export function createFighterInventory(session: PlayerSession, serial: number) {
  const observedPack = () => session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack)?.serial;
  let pack = observedPack();
  const backpack = () => {
    if (!pack) throw new Error('Backpack is not observed');
    return pack;
  };
  backpack();
  const contents = (container = backpack()) =>
    [...session.world.entities.values()].filter((item) => item.parent === container);
  const count = (graphic: number) =>
    contents()
      .filter((item) => item.graphic === graphic)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const open = (container: number) => openFighterContainer(session, container);
  const refreshBackpack = async () => {
    pack = observedPack();
    await open(backpack());
  };
  return { backpack, contents, count, open, refreshBackpack };
}

// Opening the pack can be refused for a moment (another action in flight); one retry, then throw.
export async function openFighterContainer(session: PlayerSession, container: number) {
  for (let attempt = 0; ; attempt++) {
    const before = session.world.received.get(Opcode.containerContents) ?? 0;
    session.use(container);
    try {
      await session.waitFor(
        () => (session.world.received.get(Opcode.containerContents) ?? 0) > before,
        'container contents',
        4000
      );
      return;
    } catch (error) {
      if (session.phase !== 'ready' || attempt) throw error;
      await Bun.sleep(400);
    }
  }
}

export async function initializeFighter(ctx: FighterContext) {
  const { session, trip, phase } = ctx;
  await session.refreshStatus();
  await session.refreshSkills();
  await ctx.refreshBackpack();
  if (trip.encounter) {
    const interrupted = trip.encounter.opponent;
    trip.pending = 'return';
    delete trip.encounter;
    phase(
      'reconciling-encounter',
      `Encounter with ${interrupted} was interrupted; returning to town with observed inventory instead of replaying combat or looting`
    );
  }
}
