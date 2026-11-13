import { foreseeTrade } from './knowledge';
import type { Mind } from './mind';
import { bodyOf, movement } from './motion';
import type { Option } from './options';

// Value the sale a known transformation enables, then reconsider after seeing its actual output.
export function productionIncome(
  mind: Mind,
  candidates: Option[],
  vendors: readonly { x: number; y: number; range?: number; types: string[] }[]
): Option[] {
  if (!candidates.some((o) => (o.requiresGold ?? 0) > mind.funds() && (o.value ?? 0) > 0)) return candidates;
  const visible = [...mind.sights()].flatMap((e) =>
    e.kind === 'mobile' && e.position ? [{ ...e.position, types: (mind.call(e.serial) ?? '').split('/') }] : []
  );
  const sellers = new Map([...vendors, ...visible].map((v) => [`${v.x},${v.y}:${v.types.join('/')}`, v]));
  const moving = movement(bodyOf(mind), mind.locomotion.experience, mind.temper.curiosity);
  return candidates.map((option) => {
    if (!option.consumes?.length || !option.steps.some((s) => s.verb === 'target' || s.verb === 'gump-response'))
      return option;
    const predicted = mind.appraise(option.learn ?? option.key, option.foresight)?.outcome;
    const goods = Object.entries(predicted?.gained ?? {})
      .filter(([name, amount]) => name !== 'Gold' && amount > 0)
      .map(([name, amount]) => ({ name, amount }));
    if (!goods.length) return option;
    const origin = option.steps.findLast((s) => s.verb === 'walk') ?? mind.position;
    const sales = [...sellers.values()]
      .flatMap((vendor) => {
        const selling = foreseeTrade('sell', vendor.types.join('/'), goods);
        if (!selling || !origin || !('x' in origin)) return [];
        const seconds =
          3 + moving(Math.max(0, Math.max(Math.abs(origin.x - vendor.x), Math.abs(origin.y - vendor.y)) - 2)).seconds;
        return [{ gold: selling.gained.Gold ?? 0, seconds }];
      })
      .sort((a, b) => b.gold / b.seconds - a.gold / a.seconds);
    return sales[0] ? { ...option, income: sales[0] } : option;
  });
}
