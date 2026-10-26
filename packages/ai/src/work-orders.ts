import { gold } from '@gemwright/common/items';

import { BUSINESS } from './bank-gold';
import type { LifeContext } from './life';
import { carriedOf, type Good, goodMatch, goods } from './market';
import { distance } from './navigation';
import { residentNeeds } from './needs';
import { failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { residentContext } from './resident-context';
import { personalMemory, rememberPartner } from './resident-memory';
import type { WorkOrder } from './resident-memory-types';
import { buyByTrade, sellByTrade } from './trade-deal';
import { buyFrom } from './vendor-trade';
import { professionOf } from './world';

const aliases: Record<string, Good> = {
  board: 'boards',
  boards: 'boards',
  arrow: 'arrows',
  arrows: 'arrows',
  bolt: 'bolts',
  bolts: 'bolts',
  cloth: 'cloth',
  bandage: 'bandages',
  bandages: 'bandages',
  'iron ingots': 'iron ingots',
  ingots: 'iron ingots',
  'heal potions': 'heal potions',
  'cure potions': 'cure potions',
  'poison potions': 'poison potions',
  'exceptional bows': 'exceptional bows'
};
export function parseWorkOrder(text: string) {
  const match = text
    .toLowerCase()
    .match(
      /\b(?:make|craft|supply|bring|deliver|order|collect|need(?: someone to supply)?)\s+(\d+)\s+([a-z ]+?)\s+for\s+(\d+)\s+gold\b/
    );
  const good = match?.[2] && aliases[match[2].trim()];
  const amount = Number(match?.[1]),
    price = Number(match?.[3]);
  if (
    !good ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 1000 ||
    !Number.isSafeInteger(price) ||
    price < 1 ||
    price > 100_000
  )
    return undefined;
  return { good, amount, price };
}

export function canSupply(session: PlayerSession, good: Good): boolean {
  const ctx = residentContext(session);
  if (!ctx) return false;
  const profession = professionOf(ctx.template.id)?.[0] ?? ctx.template.archetype?.id ?? '';
  const role: Partial<Record<Good, string[]>> = {
    boards: ['lumberjack', 'bowyer'],
    'iron ingots': ['miner'],
    cloth: ['tailor'],
    bandages: ['tailor'],
    arrows: ['bowyer'],
    bolts: ['bowyer'],
    'heal potions': ['alchemist'],
    'cure potions': ['alchemist'],
    'poison potions': ['alchemist'],
    'exceptional bows': ['bowyer']
  };
  return role[good]?.includes(profession) ?? false;
}

export function acceptWorkOrder(
  session: PlayerSession,
  partner: number,
  name: string,
  request: { good: Good; amount: number; price: number },
  now = Date.now()
) {
  const ctx = residentContext(session),
    point = session.world.position;
  if (!ctx || !point || session.world.map === null || !session.world.entities.get(partner)?.position) return undefined;
  const memory = personalMemory(ctx.checkpoint, now);
  if (!canSupply(session, request.good)) return `I cannot supply ${request.good}.`;
  if (memory.orders.some((order) => order.state === 'accepted' || order.state === 'ready'))
    return 'I need to finish my current order first.';
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((item) => item.layer === Layer.Backpack);
  const carried = pack ? carriedOf(session, pack.serial, request.good) : 0;
  const unitCost = ['arrows', 'bolts'].includes(request.good)
    ? goods[request.good].shopCharges
    : goods[request.good].shopPays;
  const minimum = unitCost * request.amount + 1;
  if (request.price < minimum) {
    memory.pendingOrder = { ...request, partner, name, price: minimum, until: now + 60_000 };
    ctx.persist?.();
    return `I would need ${minimum} gold for that order. Shall I take it?`;
  }
  const order: WorkOrder = {
    ...request,
    id: `order:${partner}:${now}`,
    side: 'sell',
    partner,
    name,
    map: session.world.map,
    meeting: { ...point },
    until: now + 15 * 60_000,
    state: carried >= request.amount ? 'ready' : 'accepted'
  };
  memory.orders.push(order);
  rememberPartner(ctx.checkpoint, {
    partner,
    name,
    kind: 'order',
    detail: `Agreed to supply ${request.amount} ${request.good} for ${request.price} gold`,
    id: `${order.id}:accepted`
  });
  ctx.persist?.();
  return `${name.split(' ')[0]}, agreed: ${request.amount} ${request.good} for ${request.price} gold. Collect here within 15 minutes; ask me how the order is going.`;
}

export function orderDemand(session: PlayerSession, good: Good): number {
  return (
    residentContext(session)
      ?.checkpoint.personal?.orders.filter(
        (order) =>
          order.side === 'sell' &&
          order.good === good &&
          order.until > Date.now() &&
          ['accepted', 'ready'].includes(order.state)
      )
      .reduce((n, order) => n + order.amount, 0) ?? 0
  );
}
export function reservedFor(session: PlayerSession, item: Entity): number {
  const ctx = residentContext(session);
  return (ctx?.checkpoint.personal?.orders ?? [])
    .filter(
      (order) =>
        order.side === 'sell' &&
        order.until > Date.now() &&
        ['accepted', 'ready'].includes(order.state) &&
        goods[order.good as Good] &&
        goodMatch(order.good as Good)(item)
    )
    .reduce((n, order) => n + order.amount, 0);
}

export function orderQuote(session: PlayerSession, partner: number) {
  const order = residentContext(session)?.checkpoint.personal?.orders.find(
    (entry) =>
      entry.partner === partner &&
      entry.until > Date.now() &&
      (entry.state === 'ready' || (entry.side === 'buy' && entry.state === 'accepted'))
  );
  return order ? { side: order.side, good: order.good, amount: order.amount, price: order.price } : undefined;
}
export function finishWorkOrder(session: PlayerSession, partner: number, good: string) {
  const ctx = residentContext(session);
  const order = ctx?.checkpoint.personal?.orders.find(
    (entry) => entry.partner === partner && entry.good === good && ['ready', 'accepted'].includes(entry.state)
  );
  if (!ctx || !order) return;
  order.state = 'completed';
  rememberPartner(ctx.checkpoint, {
    partner,
    name: order.name,
    kind: 'order',
    result: 'completed',
    detail: `Completed ${order.amount} ${good} for ${order.price} gold`,
    id: `${order.id}:completed`
  });
  ctx.persist?.();
}

export async function orderTurn(ctx: LifeContext): Promise<boolean> {
  const { session, checkpoint } = ctx;
  const memory = personalMemory(checkpoint);
  const order = memory.orders.find((entry) => ['accepted', 'ready'].includes(entry.state));
  if (!order) return false;
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((item) => item.layer === Layer.Backpack);
  if (!pack || !goods[order.good as Good]) return false;
  if (Date.now() > order.until || order.map !== session.world.map) {
    order.state = 'cancelled';
    order.reason = order.map !== session.world.map ? 'Cannot deliver on another facet' : 'Collection deadline passed';
    ctx.persist();
    return false;
  }
  const good = order.good as Good;
  const held = carriedOf(session, pack.serial, good);
  if (order.side === 'sell' && held < order.amount) {
    const key = `order-procure:${order.id}`;
    const condition = suppliesCondition(session, checkpoint);
    if (!objectiveBlocked(checkpoint, key, condition)) {
      const status = session.world.status;
      if (!status) return false;
      const def = goods[good];
      const bought = await buyFrom(
        {
          ...ctx,
          serial: session.world.serial ?? -1,
          status: () => session.world.status ?? status,
          carried: (parent) => session.world.childrenOf(parent),
          backpack: () => pack.serial,
          limits: BUSINESS
        },
        def.shop,
        new Map([[def.graphic, order.amount - held]]),
        Math.floor(order.price / order.amount)
      );
      if (bought) {
        ctx.persist();
        return true;
      }
      failObjective(
        checkpoint,
        key,
        suppliesCondition(session, checkpoint),
        'Order procurement unavailable; produce through my own work'
      );
    }
    return false;
  }
  order.state = 'ready';
  if (Date.now() - (order.announcedAt ?? 0) < 30_000) {
    await Bun.sleep(1000);
    ctx.check();
    return true;
  }
  if (distance(ctx.position(), order.meeting) > 3) await ctx.navigate(order.meeting, 2);
  ctx.check();
  order.announcedAt = Date.now();
  session.say(
    `${order.name.split(' ')[0]}, ${order.side === 'sell' ? 'your' : 'my'} order for ${order.amount} ${good} is ready here.`
  );
  ctx.persist();
  const partner = session.world.entities.get(order.partner);
  if (!partner?.position || distance(ctx.position(), partner.position) > 3) return true;
  const coins = session.world
    .childrenOf(pack.serial)
    .filter((item) => item.graphic === gold)
    .reduce((n, item) => n + (item.amount ?? 1), 0);
  if (order.side === 'buy' && coins < order.price) return false;
  const deal = order.side === 'sell' ? sellByTrade : buyByTrade;
  if (await deal(session, pack.serial, order.partner, goodMatch(good), order.amount, order.price))
    finishWorkOrder(session, order.partner, good);
  return true;
}

// Buyers advertise a request through heard speech; only an observed supplier can become a partner.
export function advertiseSupplyNeed(ctx: LifeContext, now = Date.now()): boolean {
  const memory = personalMemory(ctx.checkpoint, now);
  if (memory.orders.some((order) => ['accepted', 'ready'].includes(order.state))) return false;
  const need = residentNeeds(ctx.session, ctx.checkpoint, ctx.template).find(
    (entry) => entry.kind === 'supply' && entry.purchase
  );
  const good = (Object.keys(goods) as Good[]).find((key) => need?.purchase?.graphics.includes(goods[key].graphic));
  if (
    !need?.purchase ||
    !good ||
    (ctx.session.world.status && ctx.session.world.status.gold < goods[good].shopCharges * need.purchase.amount)
  )
    return false;
  const last = ctx.checkpoint.memories.findLast((entry) => entry.text.startsWith('Supply request:'));
  if (last && now - Date.parse(last.at) < 10 * 60_000) return false;
  const amount = Math.min(100, Math.max(goods[good].lot, need.purchase.amount));
  const price = Math.max(amount, Math.floor((amount * (goods[good].shopPays + goods[good].shopCharges)) / 2));
  if (!ctx.session.world.status || ctx.session.world.status.gold < price) return false;
  memory.request = {
    good,
    amount,
    price,
    map: ctx.session.world.map ?? 1,
    meeting: { ...ctx.position() },
    until: now + 10 * 60_000
  };
  ctx.session.say(`I need someone to supply ${amount} ${good} for ${price} gold. Who can take the order?`);
  ctx.checkpoint.memories.push({
    at: new Date(now).toISOString(),
    text: `Supply request: ${amount} ${good} for ${price} gold`
  });
  ctx.checkpoint.memories = ctx.checkpoint.memories.slice(-50);
  ctx.persist();
  return true;
}
