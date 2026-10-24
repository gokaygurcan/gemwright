import { TOOLS } from './bank-gold';
import { lootProvoked } from './bard-loot';
import { Blocked } from './blocked';
import { PLAIN_HUMAN_BODIES } from './bodies';
import { cemeteries } from './cemeteries';
import { prey, recognised } from './fighter-prey';
import { allServiceLocations } from './locations';
import { distance } from './navigation';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import type { DungeonRole } from './profession-dungeon';
import type { Entity } from './protocol/world';
import { skillId } from './skills';
import { buyFrom } from './vendor-trade';
import { reachRegion } from './work-areas';
import { professionOf, weightedPick } from './world';

// SBBard instruments (21 gold): drums, tambourine, lap harp, lute.
const instruments = new Set([0x0e9c, 0x0e9e, 0x0eb2, 0x0eb3, 0x0eb1, 0x0e9d]);
const PICK_INSTRUMENT = 500617; // What instrument shall you play?
// NextSkillTime after use (ServUO Peacemaking/Provocation/Discordance).
const DELAY = { Peacemaking: 10_000, Provocation: 10_000, Discordance: 6_000 };

// One bard skill use: answers the instrument cursor if asked, then the skill's own target(s).
async function play(ctx: ProfessionContext, skill: keyof typeof DELAY, targets: Entity[] | 'self') {
  const { session } = ctx;
  const instrument = ctx.carried().find((i) => instruments.has(i.graphic));
  if (!instrument) return false;
  const started = Date.now();
  const seen = new Set(session.world.journal);
  session.useSkill(skillId(skill));
  const cursor = () => session.waitFor(() => session.world.target !== null, `${skill} cursor`, 3000);
  try {
    await cursor();
    if (session.world.journal.some((e) => !seen.has(e) && e.cliloc === PICK_INSTRUMENT)) {
      session.target({ serial: instrument.serial, x: 0, y: 0, z: 0, graphic: instrument.graphic });
      await cursor();
    }
    for (const target of targets === 'self' ? [{ serial: ctx.serial, graphic: 0 }] : targets) {
      if (!session.world.target) await cursor();
      session.target({ serial: target.serial, x: 0, y: 0, z: 0, graphic: target.graphic });
    }
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    if (session.world.target) session.target(null);
    return false;
  }
  await Bun.sleep(Math.max(0, DELAY[skill] + 300 - (Date.now() - started)));
  return true;
}

const humanNpc = PLAIN_HUMAN_BODIES;
// Begs human NPCs within two tiles (vendors and townsfolk) until `want` gold is carried or ten
// tries are spent; true when it has enough.
async function beg(ctx: ProfessionContext, want: number) {
  const { session } = ctx;
  const gold = () => ctx.count(0x0eed);
  const asked = new Set<number>();
  for (let tries = 0; tries < 10 && gold() < want; tries++) {
    ctx.check();
    const here = ctx.position();
    const npc = [...session.world.entities.values()]
      .filter(
        (m) => m.kind === 'mobile' && humanNpc.has(m.graphic) && m.notoriety === 7 && m.position && !asked.has(m.serial)
      )
      .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))[0];
    if (!npc?.position) break;
    asked.add(npc.serial);
    ctx.phase('begging', 'Begging for a few coins');
    await ctx.navigate(npc.position, 1).catch(() => {});
    session.useSkill(skillId('Begging'));
    await session.waitFor(() => session.world.target !== null, 'begging cursor', 3000).catch(() => {});
    if (!session.world.target) continue;
    session.target({ serial: npc.serial, x: 0, y: 0, z: 0, graphic: npc.graphic });
    await Bun.sleep(4000);
  }
  return gold() >= want;
}

// A bard works the graveyards with music rather than steel: calm whatever attacks (Peacemaking on
// itself calms everything in range), set two undead on each other (Provocation), weaken a lone one
// (Discordance). Musicianship trains with every use.
export const runBard = (options: ProfessionOptions) =>
  runProfession(
    'bard',
    options,
    async (ctx) => {
      const { session, phase, template } = ctx;
      if (!ctx.carried().some((i) => instruments.has(i.graphic))) {
        phase('bard-gear', 'Buying an instrument from a bard');
        const shop = allServiceLocations('bard').sort(
          (a, b) => distance(ctx.position(), a) - distance(ctx.position(), b)
        )[0];
        if (!shop) throw new Blocked('no-vendor', 'No bard vendor is known');
        await reachRegion(ctx, shop);
        await buyFrom(
          { ...ctx, city: shop.city, limits: TOOLS },
          'bard',
          new Map([...instruments].map((g) => [g, 1])),
          30
        );
        // Penniless: beg townsfolk for the price of an instrument (ServUO Begging.cs), as a broke
        // player does, then try the shop again.
        if (!ctx.carried().some((i) => instruments.has(i.graphic)) && (await beg(ctx, 30)))
          await buyFrom(
            { ...ctx, city: shop.city, limits: TOOLS },
            'bard',
            new Map([...instruments].map((g) => [g, 1])),
            30
          );
        if (!ctx.carried().some((i) => instruments.has(i.graphic)))
          throw new Blocked('missing-tool', 'No instrument bought');
      }
      const grounds = professionOf(template.id)?.[1].grounds ?? { Britain: 1 };
      const groundName = weightedPick(grounds, `${ctx.serial}:${Math.floor(Date.now() / 1_800_000)}`) ?? 'Britain';
      const ground = cemeteries.find((c) => c.name === groundName) ?? cemeteries[0];
      if (!ground) return;
      await reachRegion(ctx, ground.center);
      if (distance(ctx.position(), ground.center) > 10) {
        phase('bard-travel', `Heading to the ${ground.name} cemetery`);
        await ctx.navigate(ground.center, 6);
      }
      const near = () =>
        [...session.world.entities.values()].filter(
          (m) => m.kind === 'mobile' && prey.has(m.graphic) && m.position && distance(ctx.position(), m.position) <= 10
        );
      const undead = near();
      if (session.world.combatant !== null && session.world.combatant !== undefined) {
        phase('peacemaking', 'Calming the undead around me');
        if (await play(ctx, 'Peacemaking', 'self')) ctx.progress.calmed = (ctx.progress.calmed ?? 0) + 1;
      } else if (undead.length >= 2 && undead[0] && undead[1]) {
        phase('provocation', `Setting ${undead[0].name ?? 'an undead'} on ${undead[1].name ?? 'another'}`);
        if (await play(ctx, 'Provocation', [undead[0], undead[1]]))
          ctx.progress.provoked = (ctx.progress.provoked ?? 0) + 1;
      } else if (undead[0]) {
        phase('discordance', `Discording ${undead[0].name ?? 'an undead'}`);
        if (await play(ctx, 'Discordance', [undead[0]])) ctx.progress.discorded = (ctx.progress.discorded ?? 0) + 1;
      } else if (await lootProvoked(ctx)) {
        // Coins from the undead it set on each other (bard-loot.ts).
      } else {
        phase('bard-patrol', 'Walking the cemetery for an audience');
        const from = ground.center;
        const spot = ctx.terrain.stand(
          from.x + Math.round((Math.random() - 0.5) * 30),
          from.y + Math.round((Math.random() - 0.5) * 30),
          ctx.position().z
        );
        if (spot) await ctx.navigate(spot, 2).catch(() => {});
      }
    },
    bardDungeon
  );

// In a dungeon the audience is whatever lives there (catalogs/monsters.json): calm what attacks,
// set two creatures on each other, and in a party weaken a lone one for the others to finish.
const bardDungeon: DungeonRole = {
  ready: (ctx) => ctx.carried().some((i) => instruments.has(i.graphic)),
  work: async (ctx, radius, run) => {
    const { session } = ctx;
    const near = [...session.world.entities.values()]
      .filter(
        (m) =>
          m.kind === 'mobile' &&
          recognised(m.graphic) &&
          [3, 4, 5, 6].includes(m.notoriety ?? 0) &&
          !!m.position &&
          distance(ctx.position(), m.position) <= Math.min(radius, 10)
      )
      .sort(
        (a, b) =>
          distance(ctx.position(), a.position ?? ctx.position()) -
          distance(ctx.position(), b.position ?? ctx.position())
      );
    const [first, second] = near;
    if (session.world.combatant !== null && session.world.combatant !== undefined) {
      ctx.phase('peacemaking', 'Calming the creatures around me');
      return play(ctx, 'Peacemaking', 'self');
    }
    if (first && second) {
      ctx.phase('provocation', `Setting ${first.name ?? 'a creature'} on ${second.name ?? 'another'}`);
      return play(ctx, 'Provocation', [first, second]);
    }
    if (first && run.party) {
      ctx.phase('discordance', `Weakening ${first.name ?? 'a creature'} for the party`);
      return play(ctx, 'Discordance', [first]);
    }
    return false;
  }
};
