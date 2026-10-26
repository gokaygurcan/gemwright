import { gold, instruments } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { gumpCommands } from './protocol/gumps';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';

// Player vendors (ServUO PlayerVendor): shops other players keep. A resident who sees one learns
// where it stands; one with money to spare, passing within walking reach, looks at the goods as a
// player would (double-click the vendor: its backpack opens, each item showing its price,
// 1043304) and buys what it can use: jewellery that raises one of its own skills, an instrument
// for a bard without one, a spell scroll for a mage. Buying is the item's "Buy" entry (6103) and
// the confirmation gump (1019070, button 1); the server takes the price from pack and bank.
const SHOP_NAME = 1062449;
const PRICE = 1043304;
const BUY = 3006103;
const CONFIRM = 1019070;
const SKILL_BONUS = [1060451, 1060452, 1060453, 1060454, 1060455];
const JEWELLERY = new Set<number>([Layer.Ring, Layer.Bracelet, Layer.Earrings, Layer.Neck]);
const RESERVE = 500;
const VISIT_EVERY = 6 * 3_600_000;
const isScroll = (graphic: number) => graphic >= 0x1f2d && graphic <= 0x1f6c;

// Every resident shares what any of them has seen (vendors stand still).
const known = new Map<number, { map: number; x: number; y: number }>();
const looked = new Set<number>();
const visited = new WeakMap<object, number>();

export async function noticeVendors(ctx: ProfessionContext) {
  const { session } = ctx;
  for (const m of session.world.entities.values()) {
    if (m.kind !== 'mobile' || m.notoriety !== 7 || !m.position || looked.has(m.serial)) continue;
    if (distance(ctx.position(), m.position) > 14) continue;
    looked.add(m.serial);
    await session.inspectProperties(m.serial).catch(() => {});
    const props = session.world.entities.get(m.serial)?.properties ?? [];
    if (props.some((p) => p.cliloc === SHOP_NAME)) known.set(m.serial, { map: session.world.map ?? 1, ...m.position });
  }
}

const price = (item: Entity) =>
  Number((item.properties?.find((p) => p.cliloc === PRICE)?.arguments ?? '').replace(/\D/g, '')) || 0;

function useful(ctx: ProfessionContext, item: Entity): string | undefined {
  const archetype = ctx.template.archetype;
  const skills = new Set([...(archetype?.primarySkills ?? []), ...(archetype?.supportingSkills ?? [])].map(skillId));
  const layer = ctx.terrain.tile(item.graphic, true).layer;
  if (JEWELLERY.has(layer)) {
    for (const p of item.properties ?? []) {
      if (!SKILL_BONUS.includes(p.cliloc)) continue;
      const [label, bonus] = p.arguments.replace('#', '').split('\t').map(Number);
      if (label && skills.has(label - 1044060)) {
        // Only an empty slot: what it wears already stays (inventory-use.ts compares the rest).
        const worn = ctx.session.world.childrenOf(ctx.serial).some((w) => w.layer === layer);
        if (!worn) return `+${bonus} jewellery`;
      }
    }
  }
  if (
    instruments.has(item.graphic) &&
    archetype?.id === 'bard' &&
    !ctx.carried().some((i) => instruments.has(i.graphic))
  )
    return 'an instrument';
  if (isScroll(item.graphic) && archetype?.primarySkills.includes('Magery')) return 'a spell scroll';
  return undefined;
}

// True when it went shopping.
export async function playerVendorTurn(ctx: ProfessionContext): Promise<boolean> {
  const { session } = ctx;
  await noticeVendors(ctx);
  if (Date.now() - (visited.get(session) ?? 0) < VISIT_EVERY) return false;
  const funds = ctx.count(gold) + (ctx.checkpoint.funds?.bank ?? 0);
  if (funds < RESERVE + 200) return false;
  const here = ctx.position();
  const [serial, at] =
    [...known]
      .filter(([, v]) => v.map === session.world.map && distance(here, v) <= 250)
      .sort(([, a], [, b]) => distance(here, a) - distance(here, b))[0] ?? [];
  if (serial === undefined || !at) return false;
  visited.set(session, Date.now());
  ctx.phase('player-vendor', `Looking at a player's shop near ${at.x},${at.y}`);
  await ctx.navigate(at, 2).catch(() => {});
  const vendor = session.world.entities.get(serial);
  if (!vendor?.position || distance(ctx.position(), vendor.position) > 3) return true;
  session.use(serial);
  const pack = () => session.world.childrenOf(serial).find((i) => i.layer === Layer.Backpack)?.serial;
  await session
    .waitFor(() => !!pack() && session.world.childrenOf(pack() ?? -1).length > 0, 'vendor goods', 4000)
    .catch(() => {});
  const goods = session.world.childrenOf(pack() ?? -1);
  for (const item of goods) await session.inspectProperties(item.serial).catch(() => {});
  const budget = Math.min(funds - RESERVE, Math.floor(funds * 0.4));
  const choice = goods
    .map((item) => session.world.entities.get(item.serial) ?? item)
    .map((item) => ({ item, cost: price(item), why: useful(ctx, item) }))
    .filter((c) => c.why && c.cost > 0 && c.cost <= budget)
    .sort((a, b) => a.cost - b.cost)[0];
  if (!choice) {
    ctx.log(`Looked at a player's shop (${goods.length} items); nothing I can use within ${budget} gold`);
    return true;
  }
  const entry = (await session.context(choice.item.serial).catch(() => [])).find((e) => e.cliloc === BUY);
  if (!entry) return true;
  session.selectContext(choice.item.serial, entry.index);
  const offer = () =>
    [...session.world.gumps.values()].find((g) =>
      gumpCommands(g.layout).some((c) => c[0]?.startsWith('xmfhtml') && Number(c[5]) === CONFIRM)
    );
  await session.waitFor(() => !!offer(), 'purchase confirmation', 4000).catch(() => {});
  const gump = offer();
  if (!gump) return true;
  session.replyGump(gump.serial, gump.id, 1, []);
  await session
    .waitFor(() => session.world.entities.get(choice.item.serial)?.parent === ctx.backpack(), 'bought item', 5000)
    .catch(() => {});
  const bought = session.world.entities.get(choice.item.serial)?.parent === ctx.backpack();
  ctx.log(
    bought
      ? `Bought ${choice.why} from a player's shop for ${choice.cost} gold`
      : `Tried to buy ${choice.why} for ${choice.cost} gold; the shop did not sell`
  );
  return true;
}
