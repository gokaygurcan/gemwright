import { gold } from '@gemwright/common/items';

import { type DecisionCoordinator, decisionGuard, decisionState } from './decisions';
import { bandage, type FighterContext, healPotion, observedThreat } from './fighter-context';
import { packFull } from './inventory';
import { magicProperty } from './item-quality';

// Carried gold is lost on death, but a few coins are not worth a long ride to the bank.
export const CARRIED_GOLD_LIMIT = 1500;

const hasHealing = (ctx: FighterContext) => ctx.count(bandage) >= 5 || ctx.count(healPotion) >= 1;

const lootedWearables = (ctx: FighterContext) =>
  ctx
    .contents()
    .filter(
      (item) =>
        ctx.trip.loot.includes(item.serial) &&
        item.graphic !== gold &&
        (ctx.terrain.tile(item.graphic, true).flags & 0x400000) !== 0
    );

// Loot that is costly to lose on death: wearables the server describes with magic properties. One
// piece is no reason to leave the hunt; three are worth a trip.
const importantLoot = (ctx: FighterContext) => {
  const magic = lootedWearables(ctx).filter((item) => item.properties?.some((entry) => magicProperty(entry.cliloc)));
  return magic.length >= 3 ? magic[0] : undefined;
};

// Ask for property lists of newly looted wearables, as a player hovers over new items.
async function appraiseLoot(ctx: FighterContext) {
  for (const item of lootedWearables(ctx)) {
    if (item.properties) continue;
    try {
      await ctx.session.inspectProperties(item.serial);
    } catch (error) {
      if (ctx.session.phase !== 'ready') throw error;
    }
  }
}

// A real player keeps hunting until something actually requires town. Hard needs (a full pack,
// no healing, low health) always return; soft needs (a heavy purse, magic loot) are a judgement.
export function townNeed(ctx: FighterContext): { reason: string; hard: boolean } | null {
  const status = ctx.status();
  // Hunting goes on until the pack is full (inventory.ts), as for gatherers.
  if (packFull(ctx.session, ctx.backpack(), 0.85))
    return { reason: `pack full: ${status.weight}/${status.maxWeight} stones`, hard: true };
  if (!hasHealing(ctx)) return { reason: 'healing supplies are nearly exhausted', hard: true };
  if (status.hits < status.maxHits * 0.5)
    return { reason: `health ${status.hits}/${status.maxHits} after field healing`, hard: true };
  const limit = ctx.template.behavior.temperament?.carriedGold ?? CARRIED_GOLD_LIMIT;
  if (ctx.count(gold) >= limit) return { reason: `carrying ${ctx.count(gold)} gold`, hard: false };
  const magic = importantLoot(ctx);
  if (magic)
    return {
      reason: `carrying looted magic ${ctx.terrain.tile(magic.graphic, true).name || 'item'} (${magic.serial}) worth protecting`,
      hard: false
    };
  return null;
}

// A "keep hunting" judgement holds for the same reason for ten minutes instead of re-asking every loop.
const deferred = new WeakMap<object, { reason: string; until: number }>();

// Returns the reason for a town trip, or null to keep hunting. Soft needs go to the decision
// provider with "return-town" as the deterministic baseline.
export async function planTownTrip(ctx: FighterContext, decisions?: DecisionCoordinator): Promise<string | null> {
  const need = townNeed(ctx);
  if (!need || need.hard || !decisions) return need?.reason ?? null;
  const previous = deferred.get(ctx.trip);
  // Compare reasons without amounts: a purse growing from 1,500 to 1,520 gold is the same judgement.
  const same = (a: string, b: string) => a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');
  if (previous && same(previous.reason, need.reason) && previous.until > Date.now()) return null;
  const pick = await decisions.choose({
    kind: 'town-trip',
    checkpoint: ctx.checkpoint,
    state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
      profession: 'fighter',
      reason: need.reason,
      carriedGold: ctx.count(gold),
      lootAwaitingSale: ctx.trip.loot.length,
      note: 'Carried gold and loot are lost on death. A town trip takes several minutes of travel.'
    }),
    observationRevision: ctx.session.world.revision,
    baseline: 'return-town',
    stillCurrent: decisionGuard(ctx.session),
    candidates: [
      { id: 'return-town', description: `Ride back to bank now: ${need.reason}.`, valid: () => true },
      {
        id: 'keep-hunting',
        description: 'Accept the risk and keep hunting in the graveyard before the next town trip.',
        valid: () => hasHealing(ctx)
      }
    ]
  });
  ctx.check();
  const returning = pick?.id !== 'keep-hunting';
  if (!returning) deferred.set(ctx.trip, { reason: need.reason, until: Date.now() + 10 * 60_000 });
  decisions.finish(ctx.checkpoint, pick, 'completed', returning ? `Returning: ${need.reason}` : 'Kept hunting');
  return returning ? need.reason : null;
}

// Between fights: appraise new loot and heal in the field instead of riding to town for every scratch.
export async function fieldUpkeep(ctx: FighterContext, heal: () => Promise<void>) {
  await appraiseLoot(ctx);
  const until = Math.min(ctx.deadline, Date.now() + 30_000);
  const healAt = ctx.template.behavior.temperament?.fieldHealAt ?? 0.9;
  const hurt = () => ctx.status().hits < ctx.status().maxHits * healAt || (ctx.session.world.poisonLevel ?? 0) > 0;
  if (!hurt() || !hasHealing(ctx)) return;
  ctx.phase('field-healing', `Healing in the field at ${ctx.status().hits}/${ctx.status().maxHits}`);
  while (hurt() && hasHealing(ctx) && Date.now() < until) {
    ctx.check();
    if (ctx.nearby().some((mobile) => observedThreat(mobile, ctx.session.world.combatant))) return;
    await heal();
    await Bun.sleep(1500);
    await ctx.session.refreshStatus();
  }
}
