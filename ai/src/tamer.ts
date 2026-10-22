import { readFileSync } from 'node:fs';

import { tally } from './activity';
import { Blocked } from './blocked';
import { recognised } from './fighter-prey';
import { mountEquipment } from './mount-types';
import { distance } from './navigation';
import { type ProfessionContext, type ProfessionOptions, runProfession } from './profession';
import type { DungeonRole } from './profession-dungeon';
import type { Entity } from './protocol/world';
import { skillId } from './skills';
import { companion, fightWithPet, readyBow, shoots, veterinary } from './tamer-pet';

interface Tamable {
  name: string;
  bodies: number[];
  minTame: number;
  mount: boolean;
}
const tamables = (
  JSON.parse(readFileSync(new URL('../catalogs/tamables.json', import.meta.url), 'utf8')) as { creatures: Tamable[] }
).creatures;
const byBody = new Map<number, Tamable[]>();
for (const creature of tamables)
  for (const body of creature.bodies) byBody.set(body, [...(byBody.get(body) ?? []), creature]);

const TAMED = 502799; // It seems to accept you as master.
const FAILED = 502798; // You fail to tame the creature.
const CANNOT = [502801, 1049611, 502804, 502805, 502806, 1049653, 1049654, 1049655];
const RELEASE = 6118;

// The catalog entry for an observed creature (name breaks ties between bodies such as llamas).
const profile = (mobile: Entity) => {
  const options = byBody.get(mobile.graphic) ?? [];
  return options.find((c) => mobile.name && c.name.toLowerCase() === mobile.name.toLowerCase()) ?? options[0];
};

// Releases a pet through its context menu (ServUO 6118) and ConfirmReleaseGump (button 2).
async function release(ctx: ProfessionContext, pet: Entity) {
  const { session } = ctx;
  const entry = (await session.context(pet.serial).catch(() => [])).find((e) => e.cliloc === RELEASE);
  if (!entry) return;
  const shown = session.world.gumps.size;
  session.selectContext(pet.serial, entry.index);
  await session.waitFor(() => session.world.gumps.size > shown, 'release confirmation', 3000).catch(() => {});
  const gump = [...session.world.gumps.values()].at(-1);
  if (gump) session.replyGump(gump.serial, gump.id, 2, []);
}

// A tamer looks for the toughest creature it can still learn from (ServUO gains near MinTameSkill),
// tames it, rides it if it is a mount and the tamer has none, keeps the strongest fighter as its
// companion (tamer-pet.ts) and releases everything else so the follower count never clogs. Monsters
// nearby are fought through the companion first. With nothing in sight it wanders the wilds.
export const runTamer = (options: ProfessionOptions) => {
  const tried = new Set<number>();
  return runProfession(
    'tamer',
    options,
    async (ctx) => {
      const { session, phase, log, status } = ctx;
      if (await fightWithPet(ctx, (m) => !!profile(m))) return;
      // Archery tamers re-arm between fights, never in the middle of one.
      if (shoots(ctx)) await readyBow(ctx);
      const skill = session.world.skills.get(skillId('AnimalTaming'))?.base ?? 0;
      const free = (status().maxFollowers ?? 5) - (status().followers ?? 0);
      const candidates = [...session.world.entities.values()]
        .filter(
          (m) =>
            m.kind === 'mobile' &&
            m.position &&
            !tried.has(m.serial) &&
            m.notoriety !== 1 &&
            m.serial !== ctx.checkpoint.companion?.serial
        )
        .map((m) => ({ mobile: m, profile: profile(m) }))
        .filter(
          (c): c is { mobile: Entity; profile: Tamable } =>
            !!c.profile &&
            c.profile.minTame <= skill + 5 &&
            c.profile.minTame >= skill - 30 &&
            !!c.mobile.position &&
            distance(ctx.position(), c.mobile.position) <= 14
        )
        .sort((a, b) => b.profile.minTame - a.profile.minTame);
      const target = candidates[0];
      if (!target || free < 1) {
        // Nothing to tame here: wander the countryside a little.
        const from = ctx.position();
        const spot = ctx.terrain.stand(
          from.x + Math.round((Math.random() - 0.5) * 60),
          from.y + Math.round((Math.random() - 0.5) * 60),
          from.z
        );
        phase('tamer-search', 'Looking for animals to tame');
        if (spot)
          await ctx.navigate(spot, 2).catch((error) => {
            if (!(error instanceof Blocked)) throw error;
          });
        return;
      }
      const { mobile, profile: kind } = target;
      tried.add(mobile.serial);
      phase('taming', `Taming ${mobile.name ?? kind.name} (needs ${kind.minTame})`);
      if (mobile.position && distance(ctx.position(), mobile.position) > 3) await ctx.navigate(mobile.position, 2);
      const seen = new Set(session.world.journal);
      session.useSkill(skillId('AnimalTaming'));
      await session.waitFor(() => session.world.target !== null, 'taming cursor', 3000);
      session.target({ serial: mobile.serial, x: 0, y: 0, z: 0, graphic: mobile.graphic });
      const reply = () =>
        session.world.journal.find((e) => !seen.has(e) && [TAMED, FAILED, ...CANNOT].includes(e.cliloc ?? 0))?.cliloc;
      // Taming runs in several three-second rounds; keep close so the animal does not slip away.
      const until = Date.now() + 25_000;
      while (Date.now() < until && reply() === undefined) {
        ctx.check();
        const now = session.world.entities.get(mobile.serial);
        if (now?.position && distance(ctx.position(), now.position) > 3)
          await ctx.navigate(now.position, 2).catch(() => {});
        await Bun.sleep(1500);
      }
      const result = reply();
      if (result !== TAMED) {
        log(`Taming ${kind.name} ended (${result ?? 'no reply'})`);
        return;
      }
      ctx.progress.tamed = (ctx.progress.tamed ?? 0) + 1;
      const pet = session.world.entities.get(mobile.serial);
      if (!pet) return;
      await veterinary(ctx, pet);
      if (kind.mount && !mountEquipment(session.world)) {
        phase('mounting', `Riding the newly tamed ${kind.name}`);
        session.use(pet.serial);
        return;
      }
      // The stronger of the new pet and the current companion stays; the other is released.
      const kept = companion(ctx);
      const current = ctx.checkpoint.companion;
      if (!kind.mount && (!current || (kept && kind.minTame > current.minTame))) {
        if (kept) await release(ctx, kept);
        ctx.checkpoint.companion = { serial: pet.serial, name: pet.name ?? kind.name, minTame: kind.minTame };
        phase('companion', `Keeping the ${kind.name} as a fighting companion`);
        session.say('all follow me');
        return;
      }
      phase('releasing', `Releasing the ${kind.name} to keep followers free`);
      await release(ctx, pet);
    },
    tamerDungeon
  );
};

// In a dungeon the companion fights whatever lives there (catalogs/monsters.json) except the kinds
// rated too strong to engage; the pet stays close, since only nearby pets go through a stairway
// with their master (BaseCreature.TeleportPets).
const tamerDungeon: DungeonRole = {
  ready: (ctx) => !!companion(ctx),
  work: async (ctx, _radius, run) => {
    const pet = companion(ctx);
    if (pet?.position && distance(ctx.position(), pet.position) > 3) ctx.session.say('all follow me');
    const before = ctx.progress.petKills ?? 0;
    const fought = await fightWithPet(ctx, (m) => !recognised(m.graphic));
    run.kills += (ctx.progress.petKills ?? 0) - before;
    tally(ctx.session, 'kills', (ctx.progress.petKills ?? 0) - before);
    return fought;
  }
};
