import { instruments } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { Entity } from '@gemwright/network/world';

import { checkedDelay } from './action-purpose';
import { TOOLS } from './bank-gold';
import { lootProvoked } from './bard-loot';
import { Blocked } from './blocked';
import { cemeteries } from './cemeteries';
import { prey, recognised } from './fighter-prey';
import { HAVEN_CITY, isHavenTemplate } from './haven';
import { allServiceLocations } from './locations';
import { distance } from './navigation';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import type { DungeonRole } from './profession-dungeon';
import { begForTool } from './subsistence';
import { buyTool } from './vendor-trade';
import { reachRegion } from './work-areas';
import { professionOf, weightedPick } from './world';

// SBBard instruments (21 gold): drums, tambourine, lap harp, lute.
const PICK_INSTRUMENT = 500617; // What instrument shall you play?
// NextSkillTime after use (ServUO Peacemaking/Provocation/Discordance).
const DELAY = { Peacemaking: 10_000, Provocation: 10_000, Discordance: 6_000 };

// Discordance replies that gain nothing (ServUO Discordance.cs): a target the song cannot affect,
// and one already in discord, which stays so while the bard is near. Either is skipped for a while
// instead of being played at again every six seconds.
const NO_EFFECT = 1049535;
const ALREADY_DISCORDED = 1049537;
// Provocation replies that no retry changes (ServUO Provocation.cs): no chance against this pair,
// the pair too far apart, a target that cannot be incited, a pet loyal to its master.
const UNPROVOKABLE = [1049446, 1049450, 501589, 501590];
const unplayable = new WeakMap<object, Map<number, number>>();
export const playable = (ctx: ProfessionContext, mobile: Entity) =>
  (unplayable.get(ctx.session)?.get(mobile.serial) ?? 0) <= Date.now();

// One bard skill use: answers the instrument cursor if asked, then the skill's own target(s).
export async function play(ctx: ProfessionContext, skill: keyof typeof DELAY, targets: Entity[] | 'self') {
  const { session } = ctx;
  const instrument = ctx.carried().find((i) => instruments.has(i.graphic));
  if (!instrument) return false;
  const started = Date.now();
  const seen = new Set(session.world.journal);
  session.useSkill(skillId(skill));
  const cursor = () =>
    session.waitFor(() => session.world.target !== null, `${skill} cursor`, 3000, { resource: 'target' });
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
  await checkedDelay(Math.max(0, DELAY[skill] + 300 - (Date.now() - started)), ctx.check);
  if (targets !== 'self') {
    const futile =
      skill === 'Discordance' ? [NO_EFFECT, ALREADY_DISCORDED] : skill === 'Provocation' ? UNPROVOKABLE : [];
    const reply = session.world.journal.find((e) => !seen.has(e) && futile.includes(e.cliloc ?? 0))?.cliloc;
    if (reply !== undefined) {
      const skip = unplayable.get(session) ?? new Map<number, number>();
      unplayable.set(session, skip);
      for (const target of targets)
        skip.set(target.serial, Date.now() + (reply === ALREADY_DISCORDED ? 60_000 : 600_000));
      ctx.log(
        `${skill} had no effect on ${targets.map((t) => t.name ?? t.serial).join(' and ')} (${reply}); trying others`
      );
      return false;
    }
  }
  return true;
}

export function bardTarget(ctx: Pick<ProfessionContext, 'session' | 'serial'>, mobile: Entity): boolean {
  return (
    mobile.kind === 'mobile' &&
    mobile.serial !== ctx.serial &&
    !ctx.session.world.partyMembers.has(mobile.serial) &&
    hostileNotoriety.includes(mobile.notoriety ?? 0) &&
    !ctx.session.world.deaths.has(mobile.serial) &&
    prey.has(mobile.graphic)
  );
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
        await buyTool({ ...ctx, city: shop.city, limits: TOOLS }, 'bard', [...instruments]);
        // Penniless: beg townsfolk for the price of an instrument (ServUO Begging.cs), as a broke
        // player does, then try the shop again.
        if (!ctx.carried().some((i) => instruments.has(i.graphic)) && (await begForTool(ctx, 30)))
          await buyTool({ ...ctx, city: shop.city, limits: TOOLS }, 'bard', [...instruments]);
        if (!ctx.carried().some((i) => instruments.has(i.graphic)))
          throw new Blocked('missing-tool', 'No instrument bought');
      }
      // A New Haven bard plays where it lives (haven.ts).
      const grounds = isHavenTemplate(template)
        ? { [HAVEN_CITY]: 1 }
        : (professionOf(template.id)?.[1].grounds ?? { Britain: 1 });
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
          (m) => bardTarget(ctx, m) && m.position && distance(ctx.position(), m.position) <= 10
        );
      const undead = near().filter((m) => playable(ctx, m));
      if (session.world.combatant !== null && session.world.combatant !== undefined) {
        phase('peacemaking', 'Calming the undead around me');
        if (await play(ctx, 'Peacemaking', 'self')) ctx.progress.calmed = (ctx.progress.calmed ?? 0) + 1;
      } else if (await lootProvoked(ctx)) {
        // Coins first: a bard that sets the next pair fighting before taking the last pair's gold
        // never earns while undead stay in range (Herbert Garrow, Nov 6, loop after loop).
      } else if (undead.length >= 2 && undead[0] && undead[1]) {
        phase('provocation', `Setting ${undead[0].name ?? 'an undead'} on ${undead[1].name ?? 'another'}`);
        if (await play(ctx, 'Provocation', [undead[0], undead[1]]))
          ctx.progress.provoked = (ctx.progress.provoked ?? 0) + 1;
      } else if (undead[0]) {
        phase('discordance', `Discording ${undead[0].name ?? 'an undead'}`);
        if (await play(ctx, 'Discordance', [undead[0]])) ctx.progress.discorded = (ctx.progress.discorded ?? 0) + 1;
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

// In a dungeon the audience is whatever lives there (the creature rules): calm what attacks,
// set two creatures on each other, and in a party weaken a lone one for the others to finish.
const bardDungeon: DungeonRole = {
  ready: (ctx) => ctx.carried().some((i) => instruments.has(i.graphic)),
  work: async (ctx, radius, run) => {
    const { session } = ctx;
    const near = [...session.world.entities.values()]
      .filter(
        (m) =>
          bardTarget(ctx, m) &&
          recognised(m.graphic) &&
          hostileNotoriety.includes(m.notoriety ?? 0) &&
          !!m.position &&
          distance(ctx.position(), m.position) <= Math.min(radius, 10)
      )
      .sort(
        (a, b) =>
          distance(ctx.position(), a.position ?? ctx.position()) -
          distance(ctx.position(), b.position ?? ctx.position())
      );
    const [first, second] = near.filter((m) => playable(ctx, m));
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
