import { gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { TOOLS } from './bank-gold';
import { bulkOrderTurn } from './bulk-orders';
import type { CraftSkill } from './craft-training';
import { craftRecipes, trainCraft } from './craft-training';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import { postOffer, shopShare } from './resident-offers';
import { sideTradeTurn } from './side-trade';
import { woolToBolt } from './tailor-wool';
import { buyFrom, sellTo } from './vendor-trade';
import { orderDemand, reservedFor } from './work-orders';

const cloth = 0x1766;
// Below this, material for training is not bought at a loss (gold carried and banked).
const POOR = 2000;
const uncutCloth = 0x1767;
const boltOfCloth = 0x0f95;
const scissors = new Set([0x0f9e, 0x0f9f]);
// DefTailoring with cut cloth (groups: Hats 1011375, Shirts and Pants 1111747, Misc 1015283).
export const tailoring: CraftSkill = {
  skill: 'Tailoring',
  vendor: 'tailor',
  // The sewing kit; scissors open a cutting cursor, not the tailoring menu.
  tools: new Set([0x0f9d]),
  toolPrice: 5,
  material: cloth,
  // SBTailor sells cloth in random dyed colours; the colour does not matter for sewing.
  anyHue: true,
  // Every cloth recipe from catalogs/crafts/tailoring.json; cloth costs the tailor about 2 gold a yard.
  unitCost: 2,
  recipes: craftRecipes('Tailoring')
};

// Cuts uncut cloth and bolts into cloth with scissors (ServUO IScissorable: an uncut piece gives one
// cloth, a bolt fifty). Returns whether any cloth came of it.
async function cutCloth(ctx: ProfessionContext) {
  const { session } = ctx;
  const blade = ctx.carried().find((item) => scissors.has(item.graphic));
  if (!blade) return false;
  let cut = false;
  for (const piece of ctx.carried().filter((item) => item.graphic === uncutCloth || item.graphic === boltOfCloth)) {
    ctx.check();
    const before = ctx.count(cloth);
    session.use(blade.serial);
    await session.waitFor(() => session.world.target !== null, 'scissors cursor', 3000).catch(() => {});
    if (!session.world.target) break;
    session.target({ serial: piece.serial, x: 0, y: 0, z: 0, graphic: piece.graphic });
    await session.waitFor(() => ctx.count(cloth) > before, 'cut cloth', 3000).catch(() => {});
    cut ||= ctx.count(cloth) > before;
  }
  return cut;
}

// Cloth from the tailor vendor (2 gold a yard); when the vendor's 20 yards are sold out, uncut cloth
// or a bolt from the same vendor cut with scissors; failing both, wool from the sheep (tailor-wool.ts).
async function refill(ctx: ProfessionContext, least: number) {
  if (await buyFrom(ctx, 'tailor', new Map([[cloth, Math.max(least, 60)]]), 3)) return true;
  if (!ctx.carried().some((item) => scissors.has(item.graphic)))
    await buyFrom({ ...ctx, limits: TOOLS }, 'tailor', new Map([[0x0f9f, 1]]), 15);
  await buyFrom(
    ctx,
    'tailor',
    new Map([
      [uncutCloth, Math.max(least, 40)],
      [boltOfCloth, 1]
    ]),
    110
  );
  if ((await cutCloth(ctx)) || ctx.count(cloth) >= least) return true;
  // Nothing to buy at all: wool from the sheep, spun and woven into a bolt, then cut.
  return (await woolToBolt(ctx)) && (await cutCloth(ctx));
}

// What a resident in a death robe needs first, and the shop's price for each (SBTailor).
const garments = new Map([
  [0x1f03, 18], // robe
  [0x1517, 12] // shirt
]);
function postGarments(ctx: ProfessionContext) {
  const spare = ctx
    .carried()
    .filter((item) => garments.has(item.graphic) && !item.hue)
    .slice(0, 4);
  for (const item of spare)
    postOffer({
      seller: ctx.serial,
      kind: 'clothes',
      item: item.serial,
      label: item.graphic === 0x1f03 ? 'robe' : 'shirt',
      price: shopShare(garments.get(item.graphic) ?? 12),
      at: ctx.position()
    });
}

// A tailor works in town: buys cloth from the tailor (or cuts it from uncut cloth and bolts), sews
// the garment `chooseRecipe` picks (training up to its skill goal, then only what pays) and sells it
// back, five minutes at a time.
export const runTailor = (options: ProfessionOptions) =>
  runProfession('tailor', options, async (ctx) => {
    const bandagesNeeded = orderDemand(ctx.session, 'bandages') - ctx.count(0x0e21);
    if (bandagesNeeded > 0) {
      if (!ctx.carried().some((item) => scissors.has(item.graphic)))
        await buyFrom({ ...ctx, limits: TOOLS }, 'tailor', new Map([[0x0f9f, 1]]), 15);
      await refill(ctx, bandagesNeeded + orderDemand(ctx.session, 'cloth'));
      const blade = ctx.carried().find((item) => scissors.has(item.graphic));
      const piece = ctx.carried().find((item) => item.graphic === cloth);
      if (blade && piece && !reservedFor(ctx.session, piece)) {
        const before = ctx.count(0x0e21);
        ctx.phase('gathering-bandages', 'Cutting cloth for an agreed bandage order');
        ctx.session.use(blade.serial);
        await ctx.session.waitFor(() => ctx.session.world.target !== null, 'scissors cursor', 3000).catch(() => {});
        ctx.check();
        if (ctx.session.world.target) {
          ctx.session.target({ serial: piece.serial, x: 0, y: 0, z: 0, graphic: piece.graphic });
          await ctx.session.waitFor(() => ctx.count(0x0e21) > before, 'bandages cut', 3000).catch(() => {});
          ctx.persist();
        }
      }
      return;
    }
    if (orderDemand(ctx.session, 'cloth') > ctx.count(cloth)) {
      if (!ctx.carried().some((item) => scissors.has(item.graphic)))
        await buyFrom({ ...ctx, limits: TOOLS }, 'tailor', new Map([[0x0f9f, 1]]), 15);
      await woolToBolt(ctx);
      await cutCloth(ctx);
      return;
    }
    // Bulk orders first: a tailor's steady income (bulk-orders.ts).
    const sewing = ctx.session.world.skills.get(skillId('Tailoring'))?.base ?? 0;
    if (await bulkOrderTurn({ ...ctx, refill: (_pack, least) => refill(ctx, least) }, tailoring, sewing)) return;
    // Robes and shirts are kept back and offered to residents at a discount (resident-offers.ts).
    postGarments(ctx);
    // No garment sells for more than the cloth it takes from the shop (2 gold a yard; 0 of 27
    // DefTailoring recipes pay), so a tailor short of savings sews only free cloth: wool from the
    // sheep, spun and woven. Without any, it earns at a side trade instead of sewing at a loss.
    const poor = ctx.count(gold) + (ctx.checkpoint.funds?.bank ?? 0) < POOR;
    if (poor && ctx.count(cloth) < 10) {
      if ((await woolToBolt(ctx)) && (await cutCloth(ctx))) ctx.log('Sewing with cloth from wool, not bought');
      else if (await sideTradeTurn(ctx, 'tailor', true)) return;
    }
    const until = Math.min(ctx.deadline, Date.now() + 5 * 60_000);
    const made = await trainCraft(
      {
        ...ctx,
        refill: (_pack, least) => (poor ? Promise.resolve(false) : refill(ctx, least)),
        hold: new Set(garments.keys())
      },
      tailoring,
      ctx.backpack(),
      until,
      { mode: 'profit', skill: ctx.template.behavior.trainingGoals.Tailoring }
    );
    ctx.progress.garments = (ctx.progress.garments ?? 0) + made;
    if (!made) {
      const key = 'income:cloth';
      if (!objectiveBlocked(ctx.checkpoint, key, suppliesCondition(ctx.session, ctx.checkpoint))) {
        ctx.phase('gathering-income', 'Gathering and selling cloth while garments do not pay');
        const gathered = await woolToBolt(ctx);
        if (gathered) await cutCloth(ctx);
        const earned = await sellTo(ctx, 'tailor', (item) => [cloth, uncutCloth, boltOfCloth].includes(item.graphic));
        if (earned > 0) {
          completeObjective(ctx.checkpoint, key);
          ctx.persist();
          return;
        }
        failObjective(
          ctx.checkpoint,
          key,
          suppliesCondition(ctx.session, ctx.checkpoint),
          'No cloth gathered or buyer available'
        );
        ctx.persist();
      }
      ctx.phase('tailor-wait', 'Nothing worth sewing right now (no cloth, kit or profitable garment)');
      await ctx.practise(3);
    }
  });
