import { skillId } from '@gemwright/common/skills';

import { type CraftSkill, craftRecipes, trainCraft } from './craft-training';
import { lasting } from './lasting';
import { shop } from './magery';
import type { ProfessionContext } from './profession';
import { postOffer, shopShare } from './resident-offers';

// Recall, Mark and Gate Travel scrolls are never sold by a mage (SBMage stops at the third
// circle); on this shard they come from monsters' loot, then from scribes. A caster who finds one
// puts it in its spellbook and knows the spell for good; one who cannot use it offers it to the
// residents who can. A resident with Inscription and the spell in its book writes more (blank
// scroll and the spell's reagents, DefInscription), and with Inscription 45 binds a runebook
// (eight blank scrolls, a Recall and a Gate Travel scroll), and sells both to residents
// (resident-offers.ts). Few residents get there, so scrolls and books stay scarce and dear.
export const BOOK = 0x0efa;
export const RUNEBOOK = 0x22c5;
export const travelScrolls = new Map([
  [0x1f4c, { spell: 32, label: 'recall scroll', price: 60 }],
  [0x1f59, { spell: 45, label: 'mark scroll', price: 120 }],
  [0x1f60, { spell: 52, label: 'gate travel scroll', price: 150 }]
]);
const PENS = new Set([0x0fbf, 0x0fc0]);
type Recipe = CraftSkill['recipes'][number] & { spell?: number; graphic?: number };
// Read on first use: this module sits in an import cycle with the craft code.
let catalog: Recipe[] | undefined;
const recipes = () => (catalog ??= craftRecipes('Inscription') as Recipe[]);
const skill = (ctx: ProfessionContext, name: string) => ctx.session.world.skills.get(skillId(name))?.base ?? 0;
const known = (ctx: ProfessionContext) => ctx.checkpoint.spells?.has ?? [];

// Travel scrolls carried: learned when this resident casts, otherwise offered to those who do.
export async function useScrolls(ctx: ProfessionContext) {
  const book = ctx.carried().find((item) => item.graphic === BOOK);
  for (const item of ctx.carried().filter((i) => travelScrolls.has(i.graphic))) {
    const scroll = travelScrolls.get(item.graphic);
    if (!scroll) continue;
    if (book && skill(ctx, 'Magery') >= 30 && !known(ctx).includes(scroll.spell)) {
      await ctx.session.moveItem(item.serial, book.serial).catch(() => {});
      if (!ctx.session.world.entities.has(item.serial)) {
        ctx.checkpoint.spells ??= { checked: 0, has: [] };
        ctx.checkpoint.spells.has.push(scroll.spell);
        ctx.log(`Learned ${scroll.label.replace(' scroll', '')} from a scroll`);
        ctx.persist();
      }
      continue;
    }
    postOffer({
      seller: ctx.serial,
      kind: 'scroll',
      item: item.serial,
      label: scroll.label,
      price: shopShare(scroll.price * 1.6),
      at: ctx.position()
    });
  }
  for (const item of ctx
    .carried()
    .filter((i) => i.graphic === RUNEBOOK)
    .slice(skill(ctx, 'Magery') >= 50 ? 1 : 0))
    postOffer({
      seller: ctx.serial,
      kind: 'runebook',
      item: item.serial,
      label: 'runebook',
      price: 250,
      at: ctx.position()
    });
}

// Inscription with the given recipes: a scribe's pen, blank scrolls and reagents from the mage.
export const inscriptionCraft = (allowed: CraftSkill['recipes']): CraftSkill => ({
  skill: 'Inscription',
  vendor: 'mage',
  tools: PENS,
  toolPrice: 8,
  material: 0x0e34,
  unitCost: 5,
  recipes: allowed
});
// The scrolls a scribe can write: spells in its book (DefInscription.CanCraft), not the runebook.
export const knownScrolls = (spells: readonly number[]) => recipes().filter((r) => r.spell && spells.includes(r.spell));

// A scribe's work, every two hours at most: keeps a few travel scrolls and a runebook in stock.
// True when it spent the turn writing.
export async function scribeTurn(ctx: ProfessionContext): Promise<boolean> {
  const inscription = skill(ctx, 'Inscription');
  const when = lasting('scribe', ctx.serial);
  if (inscription < 17.8 || !known(ctx).includes(32) || when.active('next')) return false;
  when.set('next', Date.now() + 2 * 3_600_000);
  const count = (graphic: number) => ctx.count(graphic);
  const wanted = [
    inscription >= 45 && count(0x1f4c) >= 1 && count(0x1f60) >= 1 && count(RUNEBOOK) < 1 ? 'runebook' : undefined,
    count(0x1f4c) < 4 ? 'recall scroll' : undefined,
    known(ctx).includes(45) && count(0x1f59) < 2 ? 'mark scroll' : undefined,
    known(ctx).includes(52) && count(0x1f60) < 2 ? 'gate travel scroll' : undefined
  ].filter((name): name is string => !!name);
  const allowed = recipes().filter(
    (r) => wanted.includes(r.name ?? '') && inscription >= r.min && (!r.spell || known(ctx).includes(r.spell))
  );
  if (!allowed.length) return false;
  const craft = inscriptionCraft(allowed);
  ctx.phase('scribing', `Writing ${wanted.join(', ')}`);
  const made = await trainCraft(
    {
      ...ctx,
      refill: (_pack, least, graphic) => shop(ctx, new Map([[graphic, Math.max(least, 8)]]), 120),
      hold: new Set([...travelScrolls.keys(), RUNEBOOK])
    },
    craft,
    ctx.backpack(),
    Math.min(ctx.deadline, Date.now() + 4 * 60_000),
    { mode: 'profit', prefer: wanted }
  );
  await useScrolls(ctx);
  return made > 0;
}
