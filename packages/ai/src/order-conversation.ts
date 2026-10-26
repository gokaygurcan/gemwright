import { type Good, goods } from './market';
import type { PlayerSession } from './protocol/session';
import { residentContext } from './resident-context';
import { personalMemory } from './resident-memory';
import { acceptWorkOrder, canSupply, parseWorkOrder } from './work-orders';

export function orderConversation(
  session: PlayerSession,
  partner: number,
  name: string,
  text: string
): string | undefined {
  const ctx = residentContext(session);
  if (!ctx) return undefined;
  const memory = personalMemory(ctx.checkpoint);
  const existing = memory.orders.find(
    (order) => order.partner === partner && ['accepted', 'ready'].includes(order.state)
  );
  if (/\bcancel\b.*\border\b|\border\b.*\bcancel\b/i.test(text) && existing) {
    existing.state = 'cancelled';
    existing.reason = 'Cancelled by agreement with the customer';
    ctx.persist?.();
    return 'All right, the order is cancelled. No payment has changed hands.';
  }
  if (/\b(?:order|delivery)\b/i.test(text) && /\b(?:how|ready|status|progress|where)\b/i.test(text) && existing)
    return existing.state === 'ready'
      ? `Your ${existing.amount} ${existing.good} are ready for ${existing.price} gold.`
      : `I am still working on your ${existing.amount} ${existing.good}. The agreed price is ${existing.price} gold.`;
  const pending = memory.pendingOrder;
  if (
    pending &&
    pending.partner === partner &&
    pending.until > Date.now() &&
    /^(?:yes|deal|agreed|okay|ok|please do)[.!\s]*$/i.test(text.trim())
  ) {
    delete memory.pendingOrder;
    return acceptWorkOrder(session, partner, name, {
      good: pending.good as Good,
      amount: pending.amount,
      price: pending.price
    });
  }
  const request = memory.request;
  if (request && request.until > Date.now() && /\b(?:agreed|can supply|will supply)\b/i.test(text)) {
    const numbers = text.match(/\d+/g)?.map(Number) ?? [];
    if (
      numbers[0] === request.amount &&
      numbers[1] === request.price &&
      text.toLowerCase().includes(request.good) &&
      !memory.orders.some((order) => ['accepted', 'ready'].includes(order.state))
    ) {
      memory.orders.push({
        ...request,
        id: `buy-order:${partner}:${Date.now()}`,
        side: 'buy',
        partner,
        name,
        state: 'accepted'
      });
      delete memory.request;
      ctx.persist?.();
      return `${name.split(' ')[0]}, agreed. I can collect ${request.amount} ${request.good} here for ${request.price} gold.`;
    }
  }
  const priced = parseWorkOrder(text);
  if (priced) return acceptWorkOrder(session, partner, name, priced);
  const unpriced = text
    .toLowerCase()
    .match(/\b(?:make|craft|supply|bring|deliver|order)\s+(?:me\s+)?(\d+)\s+([a-z ]+?)(?:[?.!]|$)/);
  if (!unpriced) return undefined;
  const good = (Object.keys(goods) as Good[]).find((key) => key === unpriced[2]?.trim());
  const amount = Number(unpriced[1]);
  if (!good || !canSupply(session, good) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000)
    return 'I cannot take that order as described. Ask me for a quantity of goods I can supply.';
  const price = Math.ceil(amount * goods[good].shopCharges * 1.1);
  memory.pendingOrder = { partner, name, good, amount, price, until: Date.now() + 60_000 };
  ctx.persist?.();
  return `I can supply ${amount} ${good} for ${price} gold, collected here within 15 minutes. Shall I take the order?`;
}
