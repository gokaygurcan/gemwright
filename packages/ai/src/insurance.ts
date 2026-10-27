import { fishingPoles, hatchets, instruments, miningTools, sewingKit } from '@gemwright/common/items';

import { offersBank, openBankBox } from './bank-gold';
import { weaponsFor } from './fighter-context';
import { pickLocation, townAt } from './locations';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { professionOf } from './world';

// Insurance against the worst outcome: a death loses everything carried, and without its tool a
// resident has no work and no income. So a spare tool of its trade (a fighter's spare weapon) waits
// in the bank, where death cannot reach it: put there at a bank visit whenever two are carried,
// and fetched after a death, or whenever the last one breaks, before any begging or buying.
const toolsByTrade: Record<string, ReadonlySet<number>> = {
  miner: miningTools,
  lumberjack: hatchets,
  fisherman: fishingPoles,
  bard: instruments,
  tailor: new Set([sewingKit]),
  bowyer: new Set([0x1022, 0x1023]), // fletcher's tools
  alchemist: new Set([0x0e9b]) // mortar and pestle
};
const toolsOf = (ctx: Pick<ProfessionContext, 'template'>) => {
  const trade = professionOf(ctx.template.id)?.[0] ?? '';
  const own = toolsByTrade[trade];
  if (own) return own;
  const weapons = weaponsFor(ctx.template);
  return weapons.size ? weapons : undefined;
};

async function bankBox(ctx: ProfessionContext) {
  const { session } = ctx;
  const town = townAt(ctx.position(), ctx.city);
  const bank = pickLocation(town, 'banker', ctx.position());
  if (!bank) return undefined;
  if (distance(ctx.position(), bank) > 8) await ctx.navigate(bank, 3).catch(() => {});
  for (const mobile of session.world.entities.values()) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(ctx.position(), mobile.position) > 11) continue;
    if (await offersBank(session, mobile.serial)) return openBankBox(ctx, mobile.serial).catch(() => undefined);
  }
  return undefined;
}

// True when it spent the turn on its insurance (a deposit, or fetching the spare).
export async function insuranceTurn(ctx: ProfessionContext): Promise<boolean> {
  const { session, checkpoint } = ctx;
  const kinds = toolsOf(ctx);
  if (!kinds) return false;
  const worn = session.world.childrenOf(ctx.serial);
  const carried = [...ctx.carried(), ...worn].filter((item) => kinds.has(item.graphic));
  const insured = checkpoint.insurance;
  if (!carried.length && insured) {
    ctx.phase('insurance', 'Fetching the spare tool I keep in the bank');
    const box = await bankBox(ctx);
    const spare = box === undefined ? undefined : session.world.childrenOf(box).find((i) => i.serial === insured.tool);
    if (!spare) {
      if (box !== undefined) delete checkpoint.insurance;
      ctx.persist();
      return box !== undefined;
    }
    await session.moveItem(spare.serial, ctx.backpack()).catch(() => {});
    delete checkpoint.insurance;
    ctx.persist();
    ctx.log('Took my spare tool out of the bank');
    return true;
  }
  // Two carried and none in the bank: one goes there, the next time the bank is close.
  const spare = carried.filter((item) => item.parent === ctx.backpack());
  if (insured || carried.length < 2 || !spare[0]) return false;
  const town = townAt(ctx.position(), ctx.city);
  const bank = pickLocation(town, 'banker', ctx.position());
  if (!bank || distance(ctx.position(), bank) > 12) return false;
  const box = await bankBox(ctx);
  if (box === undefined) return false;
  const tool = spare.at(-1) ?? spare[0];
  await session.moveItem(tool.serial, box).catch(() => {});
  if (session.world.entities.get(tool.serial)?.parent !== box) return false;
  checkpoint.insurance = { tool: tool.serial, graphic: tool.graphic };
  ctx.persist();
  ctx.log('Put a spare tool in the bank, in case I die');
  return true;
}
