import type { Entity } from '@gemwright/network/world';

import { locate } from './areas';
import { bankNearbyGold, bankSurplus, carriedGold, knownBankGold } from './bank-gold';
import { replaceDeathRobe } from './death-robe';
import { guideTurn } from './guide';
import { insuranceTurn } from './insurance';
import { tidyPack } from './inventory';
import { lasting } from './lasting';
import { pickLocation, townAt } from './locations';
import { healOthers, mendAfterDeath } from './mend';
import { distance } from './navigation';
import { lighten } from './overload';
import { playerVendorTurn } from './player-vendors';
import type { ProfessionContext } from './profession';
import { markHere } from './recall';
import { noticeHelp } from './remembered-help';
import { goalAllows, goalControlled } from './resident-goal';
import { isGhost } from './resurrection';
import { scribeTurn, useScrolls } from './scribe';
import { selfNow } from './self';
import { trainingVisit } from './training';
import { ticketTurn } from './young-ticket';

// Clothes, weight, pack, own wounds after a death, and others' wounds: what every resident sees
// to between tasks, fighters included (their town errands are their own). True when it healed.
export async function housekeeping(ctx: ProfessionContext, keep: (item: Entity) => boolean): Promise<boolean> {
  if (isGhost(ctx)) return false;
  const { session, log } = ctx;
  if (carriedGold(session, ctx.backpack()) > 0) {
    if ((await bankNearbyGold(ctx)) || (await bankSurplus(ctx, townAt(ctx.position(), ctx.city)))) return true;
  }
  // Who it is and what it has, as its screen shows it now (self.ts).
  selfNow(session, ctx.checkpoint, ctx.template);
  // Which walkable area it stands in, found once per spot (areas.ts).
  if (session.world.position) await locate(ctx.terrain, session.world.position).catch(() => undefined);
  // Who helped is remembered (remembered-help.ts).
  noticeHelp(ctx);
  // Someone asked to be shown the way (guide.ts).
  if ((!goalControlled(session) || goalAllows(session, 'commitment')) && (await guideTurn(ctx))) return true;
  await replaceDeathRobe(ctx);
  await lighten(session, ctx.backpack(), keep, log);
  await tidyPack(session, ctx.backpack(), log, ctx.terrain);
  await mendAfterDeath(ctx, log, ctx.city);
  return healOthers(ctx, log);
}

export async function optionalTurn(ctx: ProfessionContext): Promise<boolean> {
  if (!goalAllows(ctx.session, 'optional')) return false;
  const town = townAt(ctx.position(), ctx.city);
  const bank = pickLocation(town, 'banker', ctx.position());
  if (bank && distance(ctx.position(), bank) <= 8 && (await markHere(ctx, `${town} bank`).catch(() => false)))
    return true;
  if (await insuranceTurn(ctx).catch(() => false)) return true;
  // A young player ticket put to use with another resident's (young-ticket.ts).
  if (await ticketTurn(ctx).catch(() => false)) return true;
  // Travel scrolls learned or offered, and a scribe's writing (scribe.ts).
  await useScrolls(ctx);
  if (await scribeTurn(ctx)) return true;
  if (await playerVendorTurn(ctx)) return true;
  // Gold to spare (2,000 and more) goes on lessons, as players pay trainers (training.ts): every
  // twelve hours at most.
  const lessons = lasting('lessons', ctx.serial);
  const savings = ctx.status().gold + knownBankGold(ctx.checkpoint);
  if (!lessons.active('next') && savings >= 2000) {
    lessons.set('next', Date.now() + 12 * 3_600_000);
    const nearby = () =>
      [...ctx.session.world.entities.values()].filter(
        (m) => m.kind === 'mobile' && m.position && distance(ctx.position(), m.position) <= 12
      );
    await trainingVisit({ ...ctx, nearby }, townAt(ctx.position(), ctx.city)).catch(() => {});
  }
  return false;
}

// A ProfessionContext for the runners that keep their own loop (miner, lumberjack).
export type ProfessionParts = Omit<ProfessionContext, 'carried' | 'count' | 'progress' | 'practise'>;
export function asProfession(parts: ProfessionParts, practise?: ProfessionContext['practise']): ProfessionContext {
  const carried = (pack?: number) => parts.session.world.childrenOf(pack ?? parts.backpack());
  const count = (graphic: number) =>
    carried().reduce((n, item) => n + (item.graphic === graphic ? (item.amount ?? 1) : 0), 0);
  return { ...parts, carried, count, progress: {}, practise: practise ?? (async () => 0) };
}
