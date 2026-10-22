import { Blocked } from './blocked';
import { type CraftSkill, trainCraft } from './craft-training';
import { allServiceLocations, serviceLocations } from './locations';
import { distance } from './navigation';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import { Layer } from './protocol/layers';
import { buyFrom, sellTo } from './vendor-trade';
import { reachRegion } from './work-areas';

const poles = new Set([0x0dbf, 0x0dc0]);
const fish = new Set([0x09cc, 0x09cd, 0x09ce, 0x09cf, 0x097a]);
// ServUO Fishing.m_WaterTiles: land 0xA8-0xAB and 0x136-0x137; water statics 0x1797-0x179C
// (listed there with the 0x4000 static offset). The pole reaches four tiles (MaxRange 4).
const waterLand = new Set([0xa8, 0xa9, 0xaa, 0xab, 0x136, 0x137]);
const waterStatics = new Set([0x1797, 0x1798, 0x1799, 0x179a, 0x179b, 0x179c]);
const NOT_BITING = 503172;
const FAILED = 503171;

// A standing tile on the shore with water within reach, near `around`.
function findSpot(ctx: ProfessionContext, around: { x: number; y: number; z: number }, avoid: Set<string>) {
  const { terrain } = ctx;
  for (let radius = 4; radius <= 40; radius += 4) {
    for (let dx = -radius; dx <= radius; dx += 2)
      for (let dy = -radius; dy <= radius; dy += 2) {
        const stand = terrain.stand(around.x + dx, around.y + dy, around.z);
        if (!stand || avoid.has(`${stand.x >> 3},${stand.y >> 3}`)) continue;
        for (let wx = -3; wx <= 3; wx++)
          for (let wy = -3; wy <= 3; wy++) {
            const x = stand.x + wx;
            const y = stand.y + wy;
            const land = terrain.cell(x, y).land;
            if (waterLand.has(land.id)) return { stand, water: { x, y, z: land.z, graphic: 0 } };
            const still = terrain.findStatics(waterStatics, { x, y, z: stand.z }, 0)[0];
            if (still) return { stand, water: { x, y, z: still.z, graphic: still.id } };
          }
      }
  }
  return undefined;
}

const blades = new Set([0x0f51, 0x0f52]);
const rawSteak = 0x097a;
// ServUO CraftItem.m_HeatSources (ovens, fireplaces, campfires) plus forges, which also count.
const heat = new Set([
  ...Array.from({ length: 0x48e - 0x461 + 1 }, (_, i) => 0x461 + i),
  ...Array.from({ length: 0x96c - 0x92b + 1 }, (_, i) => 0x92b + i),
  ...Array.from({ length: 0xde9 - 0xde3 + 1 }, (_, i) => 0xde3 + i),
  0x0fb1,
  ...Array.from({ length: 48 }, (_, i) => 6522 + i)
]);
// DefCooking "Barbecue" (1044498): fish steak 0-100 from one raw steak, needs heat. A rolling pin
// or flour sifter from a cook (2 gold) opens the cooking menu, like a skillet.
const cooking: CraftSkill = {
  skill: 'Cooking',
  vendor: 'cook',
  tools: new Set([0x1043, 0x103e]),
  toolPrice: 5,
  material: rawSteak,
  recipes: [
    { group: 1044498, label: 1022427, min: 0, amount: 1 } // fish steak
  ]
};

// Carves carried fish into raw steaks with a dagger, then cooks them at the nearest heat source.
async function cook(ctx: ProfessionContext) {
  const { session, phase } = ctx;
  let blade = ctx.carried().find((i) => blades.has(i.graphic));
  if (!blade) {
    await buyFrom(ctx, 'blacksmith', new Map([[0x0f52, 1]]), 25);
    blade = ctx.carried().find((i) => blades.has(i.graphic));
    if (!blade) return;
  }
  for (const pile of ctx.carried().filter((i) => fish.has(i.graphic) && i.graphic !== rawSteak)) {
    ctx.check();
    session.use(blade.serial);
    await session.waitFor(() => session.world.target !== null, 'carving cursor', 3000).catch(() => {});
    if (!session.world.target) break;
    session.target({ serial: pile.serial, x: 0, y: 0, z: 0, graphic: pile.graphic });
    await Bun.sleep(900);
  }
  if (!ctx.count(rawSteak)) return;
  const fire = ctx.terrain
    .findStatics(heat, ctx.position(), 80)
    .sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b))[0];
  if (!fire) return;
  phase('cooking', `Cooking fish steaks at the fire near ${fire.x},${fire.y}`);
  await ctx.navigate(fire, 1);
  const shop = allServiceLocations('cook').sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b))[0];
  const until = Math.min(ctx.deadline, Date.now() + 4 * 60_000);
  const cooked = await trainCraft({ ...ctx, city: shop?.city ?? ctx.city }, cooking, ctx.backpack(), until);
  ctx.progress.cooked = (ctx.progress.cooked ?? 0) + cooked;
}

// A fisher keeps a pole, fishes the shore near its home town until the spot stops biting or the
// pack is heavy, then sells the catch to a fisherman.
export const runFisher = (options: ProfessionOptions) => {
  const avoid = new Set<string>();
  return runProfession('fisher', options, async (ctx) => {
    const { session, phase, log } = ctx;
    const home = serviceLocations(ctx.city, 'fisherman')[0] ?? serviceLocations(ctx.city, 'banker')[0];
    if (home) await reachRegion(ctx, home);
    let pole =
      ctx.carried().find((i) => poles.has(i.graphic)) ??
      session.world.childrenOf(ctx.serial).find((i) => poles.has(i.graphic));
    if (!pole) {
      phase('fishing-gear', 'Buying a fishing pole from a fisherman');
      await buyFrom(
        ctx,
        'fisherman',
        new Map([
          [0x0dc0, 1],
          [0x0dbf, 1]
        ]),
        20
      );
      pole = ctx.carried().find((i) => poles.has(i.graphic));
      if (!pole) throw new Blocked('missing-tool', 'No fisherman sold a fishing pole');
    }
    if (pole.parent !== ctx.serial) await session.equipItem(pole.serial, Layer.TwoHanded);
    const spot = findSpot(ctx, home ? { ...home, z: ctx.position().z } : ctx.position(), avoid);
    if (!spot) throw new Blocked('unreachable', 'No reachable shore near home');
    phase('fishing-travel', `Walking to the water at ${spot.water.x},${spot.water.y}`);
    try {
      await ctx.navigate(spot.stand, 0);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      avoid.add(`${spot.stand.x >> 3},${spot.stand.y >> 3}`);
      return;
    }
    phase('fishing', 'Fishing');
    for (let cast = 0; cast < 30; cast++) {
      ctx.check();
      if (ctx.status().weight > ctx.status().maxWeight * 0.8) break;
      const seen = new Set(session.world.journal);
      session.use(pole.serial);
      await session.waitFor(() => session.world.target !== null, 'fishing cursor', 4000);
      session.target({ serial: 0, ...spot.water });
      // The harvest takes a few seconds (cast, wait, reel in) before its reply.
      await Bun.sleep(8000 + Math.random() * 1500);
      const replies = session.world.journal.filter((e) => !seen.has(e)).map((e) => e.cliloc);
      if (replies.includes(NOT_BITING)) {
        avoid.add(`${spot.stand.x >> 3},${spot.stand.y >> 3}`);
        log('The fish are not biting here; finding another spot');
        break;
      }
      if (!replies.includes(FAILED)) ctx.progress.catches = (ctx.progress.catches ?? 0) + 1;
    }
    // Cooking trains on the catch: carve and cook a batch now and then before selling.
    if (ctx.count(0x09cc) + ctx.count(0x09cd) + ctx.count(0x09ce) + ctx.count(0x09cf) >= 10 && Math.random() < 0.4)
      await cook(ctx);
    if (
      ctx.carried().some((i) => fish.has(i.graphic)) &&
      (ctx.status().weight > ctx.status().maxWeight * 0.6 || Math.random() < 0.3)
    ) {
      phase('selling', 'Selling the catch to a fisherman');
      const earned = await sellTo(ctx, 'fisherman', (item) => fish.has(item.graphic));
      ctx.progress.earned = (ctx.progress.earned ?? 0) + earned;
      if (home && distance(ctx.position(), home) > 300) await reachRegion(ctx, home);
    }
  });
};
