import { locate } from './areas';
import { bankSurplus, knownBankGold } from './bank-gold';
import { threatsNear } from './danger';
import { escapeDanger } from './danger-response';
import { replaceDeathRobe } from './death-robe';
import { escortOpportunity } from './escort';
import { guideTurn } from './guide';
import { insuranceTurn } from './insurance';
import { tidyPack } from './inventory';
import { lasting } from './lasting';
import type { LifeContext } from './life';
import { pickLocation, townAt } from './locations';
import { noteBanked } from './loop-watch';
import { healOthers, mendAfterDeath } from './mend';
import { distance } from './navigation';
import { lighten } from './overload';
import { personalTurn } from './personal-turn';
import { playerVendorTurn } from './player-vendors';
import type { ProfessionContext } from './profession';
import type { Entity } from './protocol/world';
import { markHere, registerRecall } from './recall';
import { noticeHelp } from './remembered-help';
import { isGhost, resurrectGhost } from './resurrection';
import { scribeTurn, useScrolls } from './scribe';
import { selfNow } from './self';
import { sellingTurn } from './selling';
import { passSetback } from './setback';
import { sideTradeTurn } from './side-trade';
import { trainingVisit } from './training';
import { ticketTurn } from './young-ticket';

// The parts of every resident's turn that do not depend on its trade, in one place so a fix
// reaches every trade at once. A runner's turn is: upkeepTurn (clothes and pack, a ghost's way
// back, wounds, personal commitments, selling and banking, rest when hurt, an escort for pay),
// then its own between-work steps (life phases, dungeon runs, leaving monsters), then sideTurn
// (players' shops, a side trade when its work does not pay), then its own work. Each returns
// true when the turn was spent there.
export interface SharedTurn {
  // The trade's name, for the side trade (a fisher has none).
  trade: string;
  // Gear kept when the pack is too heavy to walk (lighten).
  keep: (item: Entity) => boolean;
  life?: LifeContext;
  // A side trade even before three flat hours: after a loop, or with no means to work.
  needed?: boolean;
}

// Clothes, weight, pack, own wounds after a death, and others' wounds: what every resident sees
// to between tasks, fighters included (their town errands are their own). True when it healed.
export async function housekeeping(ctx: ProfessionContext, keep: (item: Entity) => boolean): Promise<boolean> {
  if (isGhost(ctx)) return false;
  const { session, log } = ctx;
  // Who it is and what it has, as its screen shows it now (self.ts).
  selfNow(session, ctx.checkpoint, ctx.template);
  // Which walkable area it stands in, found once per spot (areas.ts).
  if (session.world.position) await locate(ctx.terrain, session.world.position).catch(() => undefined);
  // Who helped is remembered (remembered-help.ts).
  noticeHelp(ctx);
  // Someone asked to be shown the way (guide.ts).
  if (await guideTurn(ctx)) return true;
  await replaceDeathRobe(ctx);
  await lighten(session, ctx.backpack(), keep, log);
  await tidyPack(session, ctx.backpack(), log, ctx.terrain);
  await mendAfterDeath(ctx, log, ctx.city);
  return healOthers(ctx, log);
}

export async function upkeepTurn(ctx: ProfessionContext, turn: SharedTurn): Promise<boolean> {
  const { session, status } = ctx;
  const items = () => [...session.world.childrenOf(ctx.serial), ...ctx.carried()];
  noteBanked(session, knownBankGold(ctx.checkpoint));
  registerRecall(ctx);
  if (await housekeeping(ctx, turn.keep)) return true;
  if (isGhost(ctx)) {
    await resurrectGhost(ctx);
    return true;
  }
  if (turn.life && (await personalTurn(turn.life))) return true;
  // At a bank with the Magery for it: a rune marked there for the way back (recall.ts).
  const town = townAt(ctx.position(), ctx.city);
  const bank = pickLocation(town, 'banker', ctx.position());
  if (bank && distance(ctx.position(), bank) <= 8 && (await markHere(ctx, `${town} bank`).catch(() => false)))
    return true;
  // A spare tool in the bank, and fetched again after a death (insurance.ts).
  if (await insuranceTurn(ctx).catch(() => false)) return true;
  if (await bankSurplus(ctx, ctx.city)) return true;
  if (await sellingTurn(ctx)) return true;
  if (status().hits < status().maxHits / 2) {
    // Hurt among monsters: to the bank first, then rest there.
    const bank = pickLocation(townAt(ctx.position(), ctx.city), 'banker');
    if (bank && threatsNear(session, ctx.position(), 10).length) await escapeDanger(ctx, bank);
    await passSetback({ ...ctx, items, archetype: ctx.template.archetype }, 'health is below half');
    return true;
  }
  return escortOpportunity(ctx, status().gold + knownBankGold(ctx.checkpoint));
}

export async function sideTurn(ctx: ProfessionContext, turn: SharedTurn): Promise<boolean> {
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
  return sideTradeTurn(ctx, turn.trade, turn.needed);
}

// A ProfessionContext for the runners that keep their own loop (miner, lumberjack).
export type ProfessionParts = Omit<ProfessionContext, 'carried' | 'count' | 'progress' | 'practise'>;
export function asProfession(parts: ProfessionParts, practise?: ProfessionContext['practise']): ProfessionContext {
  const carried = (pack?: number) => parts.session.world.childrenOf(pack ?? parts.backpack());
  const count = (graphic: number) =>
    carried().reduce((n, item) => n + (item.graphic === graphic ? (item.amount ?? 1) : 0), 0);
  return { ...parts, carried, count, progress: {}, practise: practise ?? (async () => 0) };
}
