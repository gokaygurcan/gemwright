import { Blocked } from './blocked';
import { approachMobile } from './mobile-approach';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import type { Entity } from './protocol/world';
import { buyFrom } from './vendor-trade';
import { reachRegion } from './work-areas';

// Cloth the long way, when the tailor vendor has none: shear sheep with a blade (ServUO Sheep.Carve,
// one wool per sheep on Trammel, regrown after two hours), spin each wool into three balls of yarn
// on a public spinning wheel, weave five balls into a bolt on a public loom, and cut the bolt into
// fifty cloth with scissors (tailor.ts).
const wool = 0x0df8;
const yarn = new Set([0x0e1d, 0x0e1e, 0x0e1f]);
const blades = new Set([0x0f51, 0x0f52, 0x13f6, 0x0ec4]); // daggers, butcher and skinning knives
const woolly = 0xcf; // a shorn sheep has body 0xdf until its wool grows back
const SHEARED = 500452; // You place the gathered wool into your backpack.
const NOT_READY = 500449; // This sheep is not yet ready to be shorn.
const SPUN = [1010576, 1010574]; // You put the ball(s) of yarn in your backpack.
const WHEEL_BUSY = 502656;
const WOVEN = 500368; // You create some cloth and put it in your backpack.

// Sheep pastures, and public spinning wheels and looms from ServUO's Britannia town decoration
// (Data/Decoration/Britannia/britain.cfg).
const pastures = [{ x: 1319, y: 1814, z: 0 }];
const wheels = [
  { x: 1473, y: 1689, z: 0 },
  { x: 1475, y: 1689, z: 0 },
  { x: 1545, y: 1656, z: 26 },
  { x: 1390, y: 1604, z: 30 }
];
const looms = [
  { x: 1473, y: 1685, z: 0 },
  { x: 1428, y: 1610, z: 20 },
  { x: 1545, y: 1660, z: 26 },
  { x: 1392, y: 1601, z: 30 }
];
const wheelGraphics = new Set([0x1015, 0x1016, 0x1019, 0x101a, 0x101c, 0x101d, 0x10a4, 0x10a5]);
const loomGraphics = new Set([0x105f, 0x1060, 0x1061, 0x1062]);

const near = (ctx: ProfessionContext, graphics: Set<number>, point: { x: number; y: number }) =>
  [...ctx.session.world.entities.values()].find(
    (e) => e.kind === 'item' && graphics.has(e.graphic) && e.position && distance(e.position, point) <= 2
  );

// Uses `item` on `target` and waits for one of `replies` (or the expected item count to rise).
async function useOn(ctx: ProfessionContext, item: Entity, target: Entity, done: () => boolean, label: string) {
  const { session } = ctx;
  session.use(item.serial);
  await session.waitFor(() => session.world.target !== null, `${label} cursor`, 3000).catch(() => {});
  if (!session.world.target) return false;
  session.target({ serial: target.serial, x: 0, y: 0, z: 0, graphic: target.graphic });
  await session.waitFor(done, label, 6000).catch(() => {});
  return done();
}

const replied = (ctx: ProfessionContext, seen: Set<unknown>, clilocs: number[]) =>
  ctx.session.world.journal.some((e) => !seen.has(e) && clilocs.includes(e.cliloc ?? 0));

async function shear(ctx: ProfessionContext) {
  const { session, phase } = ctx;
  if (!ctx.carried().some((i) => blades.has(i.graphic)))
    await buyFrom({ ...ctx, city: 'Britain' }, 'weaponsmith', new Map([[0x13f6, 1]]), 25).catch(() => false);
  const blade = ctx.carried().find((i) => blades.has(i.graphic));
  if (!blade) return 0;
  let sheared = 0;
  for (const pasture of pastures) {
    phase('tailor-shear', 'Walking out to the sheep pasture for wool');
    await reachRegion(ctx, pasture);
    await ctx.navigate(pasture, 6);
    for (const sheep of [...session.world.entities.values()].filter(
      (e) => e.kind === 'mobile' && e.graphic === woolly && e.position && distance(e.position, pasture) <= 16
    )) {
      ctx.check();
      await approachMobile(ctx, sheep.serial).catch(() => undefined);
      const seen = new Set(session.world.journal);
      if (await useOn(ctx, blade, sheep, () => replied(ctx, seen, [SHEARED, NOT_READY]), 'shearing'))
        if (replied(ctx, seen, [SHEARED])) sheared++;
    }
  }
  return sheared;
}

async function spin(ctx: ProfessionContext) {
  const { session, phase } = ctx;
  for (const spot of wheels) {
    if (!ctx.count(wool)) return;
    phase('tailor-spin', 'Spinning wool into yarn');
    try {
      await ctx.navigate(spot, 1);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      continue;
    }
    const wheel = near(ctx, wheelGraphics, spot);
    if (!wheel) continue;
    while (ctx.count(wool)) {
      ctx.check();
      const piece = ctx.carried().find((i) => i.graphic === wool);
      if (!piece) break;
      const seen = new Set(session.world.journal);
      await useOn(ctx, piece, wheel, () => replied(ctx, seen, [...SPUN, WHEEL_BUSY]), 'spinning');
      if (!replied(ctx, seen, SPUN)) break; // busy or refused: try the next wheel
    }
  }
}

async function weave(ctx: ProfessionContext) {
  const { session, phase } = ctx;
  const balls = () =>
    ctx
      .carried()
      .filter((i) => yarn.has(i.graphic))
      .reduce((n, i) => n + (i.amount ?? 1), 0);
  for (const spot of looms) {
    if (balls() < 5) return;
    phase('tailor-weave', 'Weaving yarn into a bolt of cloth');
    try {
      await ctx.navigate(spot, 1);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      continue;
    }
    const loom = near(ctx, loomGraphics, spot);
    if (!loom) continue;
    // The loom counts five balls per bolt; another weaver's balls count toward the same bolt.
    while (balls() >= 1) {
      ctx.check();
      const ball = ctx.carried().find((i) => yarn.has(i.graphic));
      if (!ball) break;
      const seen = new Set(session.world.journal);
      const before = balls();
      await useOn(ctx, ball, loom, () => balls() < before || replied(ctx, seen, [WOVEN]), 'weaving');
      if (balls() >= before) break;
    }
  }
}

// Shears, spins and weaves; returns whether a bolt of cloth came of it. Sheep regrow for two hours,
// so a tailor tries this at most every two hours.
const lastTrip = new WeakMap<ProfessionContext['checkpoint'], number>();
export async function woolToBolt(ctx: ProfessionContext) {
  if (Date.now() - (lastTrip.get(ctx.checkpoint) ?? 0) < 2 * 60 * 60_000) return false;
  lastTrip.set(ctx.checkpoint, Date.now());
  const sheared = await shear(ctx);
  ctx.log(`Sheared ${sheared} sheep; carrying ${ctx.count(wool)} wool`);
  if (!ctx.count(wool)) return false;
  await spin(ctx);
  await weave(ctx);
  return ctx.count(0x0f95) > 0;
}
