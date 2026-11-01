import { gold } from '@gemwright/common/game/items';
import { Actions } from '@gemwright/network/replies';

import { chargedPurchase } from './bank-gold';
import { approachVendor } from './mobile-approach';
import { distance } from './navigation';
import { bestPrice, pricedGoods, type Sighting } from './price-book';
import type { ProfessionContext } from './profession';
import { onItem, useOn } from './target-action';
import { type Transformation, transformations } from './transformations';
import { buyOffers, sellChosen, sellOffers } from './vendor-shop';

// Money from what the resident knows, as a player works it out: a good some vendor sells for less
// than another pays, as it is or after a transformation the resident can do (transformations.ts),
// at prices it has seen (price-book.ts). Nothing here names a good or a trick; with no prices
// known there is no opportunity, and one appears once residents have looked at the shops.
const REACH = 300;
const KEEP = 100;

// What one unit of `graphic` fetches: the best price a known vendor pays, or what it becomes after
// further transformations, whichever is more.
function worth(graphic: number, near: (s: Sighting) => boolean, depth = 3) {
  const buyer = bestPrice('pays', graphic, near);
  let best: { value: number; steps: Transformation[]; buyer?: Sighting } = {
    value: buyer?.price ?? 0,
    steps: [],
    buyer
  };
  if (depth)
    for (const step of transformations.filter((t) => t.from === graphic)) {
      const next = worth(step.yields, near, depth - 1);
      if (next.value * step.per > best.value)
        best = { ...next, value: next.value * step.per, steps: [step, ...next.steps] };
    }
  return best;
}

// The best-paying run open to `funds` from `at`: what to buy where, what to make of it, and where
// to sell it; the cost of a missing tool counts against the gain.
export function bestOpportunity(ctx: ProfessionContext, funds: number) {
  const at = ctx.position();
  const near = (s: Sighting) => distance(at, s) <= REACH;
  let best:
    | ({ graphic: number; seller: Sighting; units: number; gain: number; tool?: Sighting } & ReturnType<typeof worth>)
    | undefined;
  for (const graphic of pricedGoods('charges')) {
    const seller = bestPrice('charges', graphic, near);
    const made = worth(graphic, near);
    if (!seller || !made.buyer || made.value <= seller.price) continue;
    const missing = made.steps.find((step) => !ctx.carried().some((item) => step.tools.has(item.graphic)));
    const tool = missing && bestPrice('charges', missing.tool, near);
    if (missing && !tool) continue;
    const units = Math.min(100, Math.floor((funds - KEEP - (tool?.price ?? 0)) / seller.price));
    const gain = units * (made.value - seller.price) - (tool?.price ?? 0);
    if (units > 0 && gain > 0 && gain > (best?.gain ?? 0)) best = { graphic, seller, units, gain, tool, ...made };
  }
  return best;
}

async function buyAt(ctx: ProfessionContext, seller: Sighting, graphic: number, want: number) {
  const { session } = ctx;
  await ctx.navigate(seller, 3);
  await approachVendor(ctx, seller.vendor);
  const stock = await buyOffers(session, seller.vendor, Actions.buy);
  if ('why' in stock) return 0;
  const offer = stock.offers.find((o) => session.world.entities.get(o.serial)?.graphic === graphic);
  const amount = Math.min(want, session.world.entities.get(offer?.serial ?? -1)?.amount ?? 0);
  if (!offer || amount < 1) return 0;
  const cost = amount * offer.price;
  await chargedPurchase(
    ctx,
    cost,
    () => session.purchaseItem(seller.vendor, offer.serial, ctx.backpack(), amount, cost),
    true
  );
  return amount;
}

// Runs the best opportunity once: buys, transforms, sells. True when it earned.
export async function opportunityTurn(ctx: ProfessionContext) {
  const { session } = ctx;
  const plan = bestOpportunity(ctx, ctx.count(gold) + (ctx.checkpoint.funds?.bank ?? 0));
  if (!plan?.buyer) return false;
  const final = plan.steps.at(-1)?.yields ?? plan.graphic;
  ctx.phase(
    'side-trade',
    `Buying ${plan.units} of 0x${plan.graphic.toString(16)} to sell as 0x${final.toString(16)} for about ${plan.gain} gold profit`
  );
  if (plan.tool && !(await buyAt(ctx, plan.tool, plan.steps[0]?.tool ?? 0, 1))) return false;
  if (!(await buyAt(ctx, plan.seller, plan.graphic, plan.units))) return false;
  for (const step of plan.steps) {
    const tool = ctx.carried().find((item) => step.tools.has(item.graphic));
    if (!tool) return false;
    for (const stack of ctx.carried().filter((item) => item.graphic === step.from)) {
      ctx.check();
      const before = ctx.count(step.yields);
      if ('why' in (await useOn(session, () => session.use(tool.serial), onItem(stack), { label: 'tool cursor' })))
        break;
      await session.waitFor(() => ctx.count(step.yields) > before, 'transformed goods', 3000).catch(() => {});
    }
  }
  await ctx.navigate(plan.buyer, 3);
  await approachVendor(ctx, plan.buyer.vendor);
  const opened = await sellOffers(session, plan.buyer.vendor, Actions.sell);
  if ('why' in opened) return false;
  const sale = opened.offers.filter(
    (offer) => offer.graphic === final && session.world.entities.get(offer.serial)?.parent === ctx.backpack()
  );
  return sale.length > 0 && (await sellChosen(session, plan.buyer.vendor, sale)).earned > 0;
}
