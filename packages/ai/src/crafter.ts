import { BUSINESS } from './bank-gold';
import { type CraftSkill, craftRecipes, trainCraft } from './craft-training';
import type { DecisionCoordinator } from './decisions';
import { learnQuality } from './item-quality';
import type { ServiceType } from './locations';
import { buyAtMarket, carriedOf, type Good, goodRecipes, goods, sellAtMarket } from './market';
import { earnBoards } from './material-income';
import { playerDemand } from './player-insight';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import { buyFrom } from './vendor-trade';
import { orderDemand } from './work-orders';

// Town crafters beyond the tailor: each buys its material from the trade's shop, crafts what
// `chooseRecipe` picks (training up to its skill goal, then only what pays), sells to the trade's
// vendor and banks exceptional pieces (craft-training.ts), five minutes at a time.
const reagents = { blackPearl: 0x0f7a, bloodmoss: 0x0f7b, bottle: 0x0f0e };
const board = 0x1bd7;

// DefAlchemy potions: each takes its own reagent and a bottle, all sold by the alchemist (SBAlchemist:
// black pearl and bloodmoss 5 gold, other reagents 3, bottles 5); the alchemist buys potions back.
export const alchemy: CraftSkill = {
  skill: 'Alchemy',
  vendor: 'alchemist',
  tools: new Set([0x0e9b]),
  toolPrice: 8,
  material: 0x0f85,
  recipes: craftRecipes('Alchemy'),
  unitCost: 3,
  costs: { [reagents.blackPearl]: 5, [reagents.bloodmoss]: 5, [reagents.bottle]: 5 }
};

// DefBowFletching bows and crossbows from boards (the carpenter's, 3 gold); the bowyer buys them back.
// Arrows and bolts need shafts and feathers and are not made.
export const bowcraft: CraftSkill = {
  skill: 'Fletching',
  vendor: 'bowyer',
  tools: new Set([0x1022, 0x1023]),
  toolPrice: 4,
  material: board,
  recipes: craftRecipes('Bowcraft'),
  unitCost: 3
};

// Buys what a recipe is short of from the shop that sells it, a few crafts' worth at a time.
const sources: Record<string, { shop: ServiceType; price: number; batch: number }> = {
  Alchemy: { shop: 'alchemist', price: 6, batch: 20 },
  Fletching: { shop: 'carpenter', price: 4, batch: 40 }
};

function runCrafter(name: string, craft: CraftSkill) {
  const source = sources[craft.skill] ?? { shop: craft.vendor, price: 5, batch: 20 };
  // Boards come from fellow residents at the bank when any are offered (market.ts), else the shop.
  const refill = async (
    ctx: ProfessionContext & { limits?: typeof BUSINESS },
    least: number,
    graphic: number,
    decisions?: DecisionCoordinator
  ) => {
    // A trip to the market town is worth it only for a good lot.
    const want = Math.max(least * 3, source.batch, graphic === goods.boards.graphic ? 60 : 0);
    if (graphic === goods.boards.graphic && (await buyAtMarket({ ...ctx, decisions }, 'boards', want, 4)) >= least)
      return true;
    return buyFrom(ctx, source.shop, new Map([[graphic, want]]), source.price);
  };
  return (options: ProfessionOptions) =>
    runProfession(name, options, async (ctx) => {
      const until = Math.min(ctx.deadline, Date.now() + 5 * 60_000);
      // Market goods this craft makes are kept from the shop for residents: plain ones by graphic
      // (alchemists' potions), exceptional ones by quality (bowyers' bows; normal bows are sold).
      const forMarket = (Object.keys(goods) as Good[]).filter((g) => goods[g].shop === craft.vendor);
      const plain = forMarket.filter((g) => !goods[g].exceptional);
      const hold = new Set(plain.map((g) => goods[g].graphic as number));
      const made = await trainCraft(
        {
          ...ctx,
          hold,
          holdExceptional: plain.length < forMarket.length,
          limits: BUSINESS,
          refill: (_pack, least, graphic) => refill({ ...ctx, limits: BUSINESS }, least, graphic, options.decisions)
        },
        craft,
        ctx.backpack(),
        until,
        {
          mode: 'profit',
          skill: ctx.template.behavior.trainingGoals[craft.skill],
          // Only the lesser potions: every strength shares one graphic, and the market prices them
          // by the lesser potion's shop prices, below what the shop pays for stronger ones.
          // The one held least comes first, so stock stays even across the market goods.
          prefer: [
            ...forMarket
              .filter((good) => orderDemand(ctx.session, good) > carriedOf(ctx.session, ctx.backpack(), good))
              .flatMap((good) => (goods[good].exceptional ? goodRecipes(good) : [`lesser ${good.replace(/s$/, '')}`])),
            ...[...plain]
              .filter((good) => carriedOf(ctx.session, ctx.backpack(), good) < 20)
              // What players ask for first (player-insight.ts), then the one held least.
              .sort(
                (a, b) =>
                  (playerDemand().get(b) ?? 0) - (playerDemand().get(a) ?? 0) ||
                  ctx.count(goods[a].graphic) - ctx.count(goods[b].graphic)
              )
              .map((good) => `lesser ${good.replace(/s$/, '')}`),
            // Exceptional goods name the recipes that can turn out exceptional (a bowyer's bows).
            ...forMarket
              .filter((good) => carriedOf(ctx.session, ctx.backpack(), good) < goods[good].lot)
              .flatMap(goodRecipes)
          ]
        }
      );
      ctx.progress.crafted = (ctx.progress.crafted ?? 0) + made;
      await learnQuality(ctx.session, ctx.carried());
      for (const good of forMarket)
        await sellAtMarket(
          { ...ctx, decisions: options.decisions },
          good,
          carriedOf(ctx.session, ctx.backpack(), good),
          4
        );
      if (!made && name === 'bowyer' && (await earnBoards(ctx))) return;
      if (!made) {
        ctx.phase(
          `${name}-wait`,
          `Nothing worth making right now (no ${craft.skill} material, tool or profitable recipe)`
        );
        // Practice that ends early still makes the crafter wait out the three minutes before
        // trying the shop again, instead of asking it every few seconds.
        const resumeAt = Math.min(ctx.deadline, Date.now() + 3 * 60_000);
        await ctx.practise(3);
        while (Date.now() < resumeAt) {
          ctx.check();
          await Bun.sleep(2000);
        }
      }
    });
}

export const runAlchemist = runCrafter('alchemist', alchemy);
export const runBowyer = runCrafter('bowyer', bowcraft);
