import type { CraftSkill } from './craft-training';
import { craftRecipes, trainCraft } from './craft-training';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import { woolToBolt } from './tailor-wool';
import { buyFrom } from './vendor-trade';

const cloth = 0x1766;
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
    await buyFrom(ctx, 'tailor', new Map([[0x0f9f, 1]]), 15);
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

// A tailor works in town: buys cloth from the tailor (or cuts it from uncut cloth and bolts), sews
// the garment `chooseRecipe` picks (training up to its skill goal, then only what pays) and sells it
// back, five minutes at a time.
export const runTailor = (options: ProfessionOptions) =>
  runProfession('tailor', options, async (ctx) => {
    const until = Math.min(ctx.deadline, Date.now() + 5 * 60_000);
    const made = await trainCraft(
      { ...ctx, refill: (_pack, least) => refill(ctx, least) },
      tailoring,
      ctx.backpack(),
      until,
      { mode: 'profit', skill: ctx.template.behavior.trainingGoals.Tailoring }
    );
    ctx.progress.garments = (ctx.progress.garments ?? 0) + made;
    if (!made) {
      ctx.phase('tailor-wait', 'Nothing worth sewing right now (no cloth, kit or profitable garment)');
      await ctx.practise(3);
    }
  });
