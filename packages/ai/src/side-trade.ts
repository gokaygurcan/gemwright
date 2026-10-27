import { fishingPoles, gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { fishingTurn } from './fisher';
import { pickLocation, townAt } from './locations';
import { forcedToWork } from './loop-watch';
import { distance } from './navigation';
import { errand, objectiveBlocked, suppliesCondition } from './objective-memory';
import type { ProfessionContext } from './profession';
import { oreNear, oreTurn, woodNear, woodTurn } from './side-gathering';
import { trainFromNpc } from './training';
import { tuning } from './tuning';

// A side trade for a resident whose own work does not pay, as players pick one up (fishing here;
// wood and ore in side-gathering.ts): most residents
// use 400-500 of their 700 skill points, so there is room. Fishing first: a pole costs about 15
// gold, it works from 0 skill on any shore near town, and every fisherman buys the catch. With the
// money for it, the resident first pays a fisherman to teach it up to 30 (one gold per 0.1 point);
// a broke one begs for the pole's price and learns by fishing. It fishes while it is broke, and
// for two hours after any three hours in which its funds did not grow, or after a loop, and a
// fighter without the weapon or bandages it cannot afford fishes until it can (`needed`).
const CHECK_MS = tuning.sideTrade.checkHours * 3_600_000;
const SPELL_MS = tuning.sideTrade.spellHours * 3_600_000;
const ROOM = 650;
const LESSON_TO = tuning.sideTrade.lessonTo;
const avoid = new Set<string>();

const funds = (ctx: ProfessionContext) => ctx.count(gold) + (ctx.checkpoint.funds?.bank ?? 0);
const skill = (ctx: ProfessionContext, name: string) => ctx.session.world.skills.get(skillId(name))?.base ?? 0;

// True when it spent the turn on its side trade.
export async function sideTradeTurn(ctx: ProfessionContext, profession: string, needed = false): Promise<boolean> {
  if (forcedToWork(ctx.session)) return false;
  if (profession === 'fisher') return false;
  const total = [...ctx.session.world.skills.values()].reduce((n, s) => n + (s.base ?? 0), 0);
  if (total >= ROOM && skill(ctx, 'Fishing') < 1 && !needed) return false;
  const now = Date.now();
  ctx.checkpoint.sideTrade ??= { checkAt: now, funds: funds(ctx), until: 0 };
  const state = ctx.checkpoint.sideTrade;
  if (now - state.checkAt >= CHECK_MS) {
    if (funds(ctx) <= state.funds) state.until = now + SPELL_MS;
    state.checkAt = now;
    state.funds = funds(ctx);
    ctx.persist();
  }
  const broke = funds(ctx) < 100;
  if (!broke && !needed && state.until <= now) return false;
  // Only what is in walking reach: nobody crosses the land for a side trade. Each resident leans
  // to one of the trades (by its serial), and takes another when its own is not at hand.
  const town = townAt(ctx.position(), ctx.city);
  const shop = pickLocation(town, 'fisherman', ctx.position());
  const fishing = !!shop && distance(ctx.position(), shop) <= 300;
  // A side trade is not the resident's own work: a miner does not dig ore on the side.
  const choices = [
    fishing ? 'fish' : '',
    profession !== 'lumberjack' && woodNear(ctx) ? 'wood' : '',
    profession !== 'miner' && oreNear(ctx) ? 'ore' : ''
  ].filter(
    (kind) => kind && !objectiveBlocked(ctx.checkpoint, `side:${kind}`, suppliesCondition(ctx.session, ctx.checkpoint))
  );
  if (!choices.length) return false;
  // What paid best before is taken again (gold a minute, kept in the checkpoint); one time in five
  // another is tried, and with nothing learned yet the resident's own leaning decides.
  ctx.checkpoint.paid ??= {};
  const paid = ctx.checkpoint.paid;
  const rate = (kind: string) => (paid[kind] ? paid[kind].gold / Math.max(1, paid[kind].minutes) : undefined);
  const known = choices.filter((c) => rate(c) !== undefined).sort((a, b) => (rate(b) ?? 0) - (rate(a) ?? 0));
  const pick =
    known.length && Math.random() >= 0.2
      ? (known[0] ?? choices[0])
      : (choices[Math.floor(Math.random() * choices.length)] ?? choices[ctx.serial % choices.length]);
  const startGold = funds(ctx);
  const started = Date.now();
  const record = () => {
    const entry = paid[pick ?? 'fish'] ?? { gold: 0, minutes: 0 };
    entry.gold += funds(ctx) - startGold;
    entry.minutes += (Date.now() - started) / 60_000;
    paid[pick ?? 'fish'] = entry;
    ctx.persist();
  };
  // A side trade that gains nothing is left for two hours (objective-memory.ts).
  if (pick === 'wood' || pick === 'ore') {
    let worked = false;
    await errand(
      ctx,
      `side:${pick}`,
      pick === 'wood' ? 'chopping wood on the side' : 'digging ore on the side',
      async () => {
        worked = pick === 'wood' ? await woodTurn({ ...ctx, city: town }) : await oreTurn({ ...ctx, city: town });
      }
    );
    if (worked) {
      record();
      return true;
    }
  }
  if (!shop || !fishing) return false;
  const local = { ...ctx, city: town };
  if (
    skill(ctx, 'Fishing') < LESSON_TO &&
    funds(ctx) >= tuning.sideTrade.lessonMinGold &&
    now - (ctx.checkpoint.training?.Fishing ?? 0) > 24 * 3_600_000
  ) {
    ctx.phase('side-trade', `Taking up fishing; paying a fisherman in ${town} for lessons`);
    await ctx.navigate(shop, 4).catch(() => {});
    const nearby = () =>
      [...ctx.session.world.entities.values()].filter(
        (m) => m.kind === 'mobile' && m.position && distance(ctx.position(), m.position) <= 12
      );
    for (const npc of nearby().filter((m) => m.notoriety === 7)) {
      if (await trainFromNpc({ ...local, nearby }, npc, 'Fishing', 350).catch(() => 0)) break;
    }
  }
  const pole = [...ctx.carried(), ...ctx.session.world.childrenOf(ctx.serial)].some((i) => fishingPoles.has(i.graphic));
  // No pole and no money for one: no begging; fishing is simply not open to it now.
  if (!pole && funds(ctx) < 20) return false;
  ctx.phase('side-trade', broke ? 'Fishing for a living until money comes in' : 'Fishing on the side');
  await errand(ctx, 'side:fish', 'fishing on the side', () => fishingTurn(avoid)(local));
  record();
  return true;
}

// For runners without a ProfessionContext (miner, lumberjack): the side trade after a loop, while
// the setback's two hours last (setback.ts). True when it spent the turn on it.
export async function loopSideTrade(
  parts: Omit<ProfessionContext, 'carried' | 'count' | 'progress' | 'practise' | 'persist' | 'template'> & {
    persist: () => void;
    template: ProfessionContext['template'];
  },
  profession: string
): Promise<boolean> {
  if ((parts.checkpoint.sideTrade?.until ?? 0) <= Date.now()) return false;
  const carried = (pack?: number) => parts.session.world.childrenOf(pack ?? parts.backpack());
  const count = (graphic: number) =>
    carried().reduce((n, item) => n + (item.graphic === graphic ? (item.amount ?? 1) : 0), 0);
  return sideTradeTurn({ ...parts, carried, count, progress: {}, practise: async () => 0 }, profession, true);
}
