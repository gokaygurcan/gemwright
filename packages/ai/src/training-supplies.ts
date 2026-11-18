import { craftSystemOf, listsOf, sells } from '@gemwright/common/game/rules';

import { TRAINING } from './bank-rules';
import { bankBatch, bankSteps, byWay } from './banking';
import type { Mind } from './mind';
import type { Option, Step } from './options';
import type { Places } from './planning';

export interface Supply {
  graphics: readonly number[];
  amount: number;
  plain?: boolean;
  system?: string;
  scroll?: { circle: number };
}

export function prepareTraining(mind: Mind, skill: string, needs: readonly Supply[], places: Places) {
  const here = mind.position;
  if (!here) return;
  const owned = [...mind.belongings()];
  const carried: number[] = [];
  const requested: { serial: number; amount: number }[] = [];
  const buying: { need: Supply; amount: number }[] = [];
  for (const need of needs) {
    let missing = need.amount;
    const matches = (id: number) =>
      need.graphics.includes(mind.graphicOf(id) ?? -1) && (!need.plain || !(mind.sight(id)?.hue ?? 0));
    for (const [id, item] of owned) {
      if (!mind.carrying(id) || !matches(id)) continue;
      missing -= Math.min(missing, item.amount);
      carried.push(id);
    }
    for (const [id, item] of owned) {
      if (missing <= 0 || !mind.banked(id) || !matches(id)) continue;
      const amount = Math.min(missing, item.amount);
      requested.push({ serial: id, amount });
      missing -= amount;
    }
    if (missing > 0) buying.push({ need, amount: missing });
  }
  const steps: Step[] = [];
  const batch = requested.length ? bankBatch(mind, requested) : undefined;
  if (requested.length) {
    const taking = batch && bankSteps(mind, places.bankers, batch.batch);
    if (!taking) return;
    steps.push(...taking);
  }
  const seen = [...mind.sights()].flatMap((e) =>
    e.kind === 'mobile' && e.position ? [{ ...e.position, types: (mind.call(e.serial) ?? '').split('/') }] : []
  );
  const sellers = [...places.vendors, ...seen].filter((p) => mind.allowed(p) && mind.reachable(p));
  let cost = 0;
  for (const { need, amount } of buying) {
    const offers = byWay(mind.steps, here, here.map, sellers).flatMap((vendor) => {
      const goods = vendor.types
        .flatMap((type) => sells(type))
        .filter((o) => need.graphics.includes(o.graphic) && (!need.system || craftSystemOf(o.type) === need.system));
      // SBMage's first three circles are generated in a loop, outside the static vendor table.
      if (need.scroll && need.scroll.circle <= 3 && vendor.types.some((t) => listsOf(t).includes('SBMage')))
        goods.push({
          type: 'SpellScroll',
          graphic: need.graphics[0] as number,
          price: 12 + (need.scroll.circle - 1) * 10
        });
      return goods.map((offer) => ({ vendor, offer }));
    });
    const pick = offers[0];
    if (!pick) return;
    cost += pick.offer.price * amount;
    steps.push(
      { verb: 'walk', x: pick.vendor.x, y: pick.vendor.y, range: 2 },
      { verb: 'buy', graphic: pick.offer.graphic, price: pick.offer.price, amount, training: true }
    );
  }
  if (
    cost &&
    (mind.funds() - cost < TRAINING.reserve ||
      mind.care.trainingSpent() + cost > Math.max(TRAINING.perHour, mind.funds() * TRAINING.share))
  ) {
    if (mind.bankGold === undefined && places.bankers.length) {
      const bank = byWay(mind.steps, here, here.map, places.bankers)[0];
      if (bank)
        return {
          ready: false,
          consumes: carried,
          option: {
            key: `check funds for ${skill}`,
            value: mind.temper.curiosity,
            seconds: 3,
            steps: [{ verb: 'walk', ...bank, range: 3 }, { verb: 'balance' }]
          } satisfies Option
        };
    }
    return;
  }
  const consumes = [...carried, ...requested.map((r) => r.serial)];
  if (!steps.length) return { ready: true, consumes };
  return {
    ready: false,
    consumes,
    option: {
      key: `prepare practice ${skill}`,
      requiresGold: cost,
      loads: batch?.weight,
      consumes,
      value: mind.temper.diligence,
      seconds: 3 * steps.length,
      steps
    } satisfies Option
  };
}
