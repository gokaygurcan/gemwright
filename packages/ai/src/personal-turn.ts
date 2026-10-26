import { canPause } from './action-purpose';
import { observeAid } from './aid';
import { Blocked } from './blocked';
import { commitmentTurn } from './commitments';
import { companionInitiative } from './companion-initiative';
import { guildRepairTurn } from './guild-repairs';
import { useAcquiredItems } from './inventory-use';
import type { LifeContext } from './life';
import { failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { updatePersonalGoals } from './personal-goals';
import { registerResident, residentCombat } from './resident-context';
import { sessionBreakTurn } from './session-habits';
import { learnWork } from './strategy-learning';
import { advertiseSupplyNeed, orderTurn } from './work-orders';

export async function personalTurn(ctx: LifeContext): Promise<boolean> {
  registerResident(ctx);
  observeAid(ctx.session);
  learnWork(ctx.session, ctx.checkpoint, ctx.template);
  updatePersonalGoals(ctx);
  if (!canPause(ctx.session) || !ctx.session.world.status || ctx.session.world.status.hits <= 0) return false;
  if (await residentCombat(ctx.session)?.support?.()) return true;
  await sessionBreakTurn(ctx);
  if (await useAcquiredItems(ctx.session)) return true;
  const memory = ctx.checkpoint.personal;
  const key = `personal:${memory?.commitment?.id ?? memory?.orders.find((order) => ['accepted', 'ready'].includes(order.state))?.id ?? 'none'}`;
  const condition = suppliesCondition(ctx.session, ctx.checkpoint);
  if (objectiveBlocked(ctx.checkpoint, key, condition)) return false;
  try {
    if (await commitmentTurn(ctx)) return true;
    if (await orderTurn(ctx)) return true;
  } catch (error) {
    ctx.check();
    if (!(error instanceof Blocked)) throw error;
    failObjective(ctx.checkpoint, key, condition, error.message);
    if (memory?.commitment?.state === 'active') memory.commitment.state = 'paused';
    ctx.persist();
    return false;
  }
  if (await guildRepairTurn(ctx)) return true;
  if (companionInitiative(ctx)) return true;
  advertiseSupplyNeed(ctx);
  return false;
}
