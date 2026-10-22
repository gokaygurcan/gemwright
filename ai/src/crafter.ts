import { type CraftSkill, craftRecipes, trainCraft } from './craft-training';
import type { ServiceType } from './locations';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import { buyFrom } from './vendor-trade';

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
  const refill = (ctx: ProfessionContext, least: number, graphic: number) =>
    buyFrom(ctx, source.shop, new Map([[graphic, Math.max(least * 3, source.batch)]]), source.price);
  return (options: ProfessionOptions) =>
    runProfession(name, options, async (ctx) => {
      const until = Math.min(ctx.deadline, Date.now() + 5 * 60_000);
      const made = await trainCraft(
        { ...ctx, refill: (_pack, least, graphic) => refill(ctx, least, graphic) },
        craft,
        ctx.backpack(),
        until,
        { mode: 'profit', skill: ctx.template.behavior.trainingGoals[craft.skill] }
      );
      ctx.progress.crafted = (ctx.progress.crafted ?? 0) + made;
      if (!made) {
        ctx.phase(
          `${name}-wait`,
          `Nothing worth making right now (no ${craft.skill} material, tool or profitable recipe)`
        );
        await ctx.practise(3);
      }
    });
}

export const runAlchemist = runCrafter('alchemist', alchemy);
export const runBowyer = runCrafter('bowyer', bowcraft);
