import { skillId } from '@gemwright/common/skills';

import { recentlyHurt, takingUrgentAction, urgentAction } from './action-purpose';
import { TOOLS } from './bank-gold';
import { combatPosition } from './combat-position';
import { threatsNear } from './danger';
import { pickLocation } from './locations';
import { distance } from './navigation';
import { petFightReadiness } from './pet-risk';
import { petSource } from './pets';
import type { ProfessionContext } from './profession';
import type { Entity } from './protocol/world';
import { rangedGraphics, rangedWeapon } from './ranged-weapons';
import { buyFrom } from './vendor-trade';

const bandage = 0x0e21;
const bows = rangedGraphics;
const arrow = 0x0f3f;
const restocked = new WeakMap<ProfessionContext, number>();
const NOT_DAMAGED = 500955; // That being is not damaged!
// Human and elf bodies: players and NPCs are never sent against.
const humanoid = new Set([400, 401, 605, 606]);
// An unseen companion is missing, not confirmed dead. After five minutes the resident moves on.
const LOST_AFTER = 5 * 60_000;
const healingUntil = new WeakMap<ProfessionContext, number>();
const lastSeen = new WeakMap<ProfessionContext, number>();

// Veterinary trains on a pet: bandage it until the server says it is not damaged (bandaging an
// animal uses Veterinary; ServUO Bandage), restocking bandages from a healer.
export async function veterinary(ctx: ProfessionContext, pet: Entity) {
  const { session } = ctx;
  if ((healingUntil.get(ctx) ?? 0) > Date.now()) return;
  if (ctx.count(bandage) < 5 && !takingUrgentAction(session))
    await buyFrom({ ...ctx, limits: TOOLS }, 'healer', new Map([[bandage, 10]]), 8).catch(() => false);
  const roll = ctx.carried().find((item) => item.graphic === bandage);
  const now = session.world.entities.get(pet.serial);
  if (!roll || !now?.position) return;
  ctx.check();
  if (distance(ctx.position(), now.position) > 1) await ctx.navigate(now.position, 1);
  const seen = new Set(session.world.journal);
  const before = now.hits;
  session.use(roll.serial);
  await session.waitFor(() => session.world.target !== null, 'bandage cursor', 3000).catch(() => {});
  ctx.check();
  if (!session.world.target) return;
  session.target({ serial: pet.serial, x: 0, y: 0, z: 0, graphic: pet.graphic });
  healingUntil.set(ctx, Date.now() + 8000);
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    ctx.check();
    const observed = session.world.entities.get(pet.serial);
    const reply = session.world.journal.find(
      (entry) => !seen.has(entry) && [NOT_DAMAGED, 500969, 500968, 500962, 500963].includes(entry.cliloc ?? 0)
    );
    if (reply || (before !== undefined && observed?.hits !== undefined && observed.hits > before)) {
      if (reply?.cliloc === 500969 || (before !== undefined && observed?.hits !== undefined && observed.hits > before))
        ctx.progress.bandaged = (ctx.progress.bandaged ?? 0) + 1;
      return;
    }
    if (!observed?.position || session.world.deaths.has(pet.serial) || recentlyHurt(session)) return;
    await Bun.sleep(100);
  }
  ctx.log('Veterinary outcome unconfirmed; allowing the bandage time before another attempt');
}

// Archery tamers (archetype with Archery) shoot alongside their pet.
export const shoots = (ctx: ProfessionContext) =>
  !!ctx.template.archetype &&
  [...ctx.template.archetype.primarySkills, ...ctx.template.archetype.supportingSkills].includes('Archery');

// Wields a bow and keeps arrows, buying from a bowyer at most every ten minutes. Returns whether
// the tamer can shoot now.
export async function readyBow(ctx: ProfessionContext) {
  const { session } = ctx;
  const held = () => session.world.childrenOf(ctx.serial).find((item) => bows.has(item.graphic));
  const ammo = () =>
    rangedWeapon((held() ?? ctx.carried().find((item) => bows.has(item.graphic)))?.graphic)?.ammo ?? arrow;
  if ((!held() && !ctx.carried().some((i) => bows.has(i.graphic))) || ctx.count(ammo()) < 20) {
    if (Date.now() - (restocked.get(ctx) ?? 0) > 10 * 60_000) {
      restocked.set(ctx, Date.now());
      ctx.phase('bow-restock', 'Buying a bow and arrows from a bowyer');
      const wanted = new Map([[ammo(), 150]]);
      if (!held() && !ctx.carried().some((i) => bows.has(i.graphic))) wanted.set(0x13b2, 1);
      await buyFrom({ ...ctx, limits: TOOLS }, 'bowyer', wanted, 60).catch(() => false);
    }
  }
  const bow = held() ?? ctx.carried().find((i) => bows.has(i.graphic));
  if (!bow || !ctx.count(rangedWeapon(bow?.graphic)?.ammo ?? arrow)) return false;
  if (bow.parent !== ctx.serial)
    await session.equipItem(bow.serial, ctx.terrain.tile(bow.graphic, true).layer || 2).catch(() => {});
  return held() !== undefined;
}

// The kept companion, or undefined once it has been missing too long.
export function companion(ctx: ProfessionContext) {
  petSource(ctx.session, 'companion', () => (ctx.checkpoint.companion ? [ctx.checkpoint.companion.serial] : []));
  const memo = ctx.checkpoint.companion;
  if (!memo) return undefined;
  const pet = ctx.session.world.entities.get(memo.serial);
  if (pet?.position && !ctx.session.world.deaths.has(memo.serial)) {
    lastSeen.set(ctx, Date.now());
    return pet;
  }
  if (Date.now() - (lastSeen.get(ctx) ?? Date.now()) > LOST_AFTER) {
    ctx.log(`Lost track of ${memo.name}; looking for a new companion`);
    ctx.checkpoint.companion = undefined;
    ctx.persist();
  }
  if (!lastSeen.has(ctx)) lastSeen.set(ctx, Date.now());
  return undefined;
}

// Fights through the companion (ServUO BaseAI owner orders): "all kill" at a monster near the tamer,
// bandaging the pet when it drops below half health, retreating with it when the tamer itself is
// badly hurt, then "all follow me". Monsters are grey like animals on ServUO, so tamable bodies
// (`animal`) and humanoids are left alone. Returns whether a fight took place.
async function petEncounter(ctx: ProfessionContext, animal: (mobile: Entity) => boolean): Promise<boolean> {
  const { session, status } = ctx;
  const pet = companion(ctx);
  const memo = ctx.checkpoint.companion;
  if (!pet?.position || !memo) return false;
  await session.inspect(pet.serial).catch(() => {});
  const observedPet = session.world.entities.get(pet.serial) ?? pet;
  if (distance(ctx.position(), pet.position) > 8) session.say('all follow me');
  const hostile = [...session.world.entities.values()]
    .filter(
      (m) =>
        m.kind === 'mobile' &&
        m.serial !== pet.serial &&
        m.serial !== ctx.serial &&
        !!m.position &&
        [3, 4, 5, 6].includes(m.notoriety ?? 0) &&
        !humanoid.has(m.graphic) &&
        !animal(m) &&
        !session.world.deaths.has(m.serial) &&
        petFightReadiness(
          observedPet,
          m,
          ctx.count(bandage),
          session.world.skills.get(skillId('Veterinary'))?.value ?? 0
        ).ok &&
        distance(ctx.position(), m.position) <= 10
    )
    .map((m) => ({ m, range: m.position ? distance(ctx.position(), m.position) : 99 }))
    .sort((a, b) => a.range - b.range)[0]?.m;
  if (!hostile) {
    await session.inspect(pet.serial).catch(() => {});
    const hurt = session.world.entities.get(pet.serial);
    if (hurt?.hits !== undefined && hurt.maxHits && hurt.hits < hurt.maxHits * 0.8) await veterinary(ctx, hurt);
    return false;
  }
  if (distance(ctx.position(), pet.position) > 8) return false;
  const archer = shoots(ctx) && (await readyBow(ctx));
  const ranged = rangedWeapon(ctx.session.world.childrenOf(ctx.serial).find((item) => bows.has(item.graphic))?.graphic);
  ctx.phase('pet-combat', `Sending ${memo.name} at ${hostile.name ?? hostile.serial}`);
  const order = (await session.context(pet.serial).catch(() => [])).find(
    (entry) => entry.cliloc === 3006111 && !(entry.flags & 1)
  );
  if (!order) return false;
  session.selectContext(pet.serial, order.index);
  await session.waitFor(() => session.world.target !== null, 'pet order cursor', 3000).catch(() => {});
  ctx.check();
  if (!session.world.target) return false;
  let retreat = false;
  try {
    session.target({ serial: hostile.serial, x: 0, y: 0, z: 0, graphic: hostile.graphic });
    // The archer stays back and shoots while the pet holds the monster.
    if (archer) await session.attack(hostile.serial).catch(() => {});
    const until = Date.now() + 60_000;
    while (Date.now() < until && !session.world.deaths.has(hostile.serial)) {
      ctx.check();
      if (status().hits < status().maxHits * 0.6 || recentlyHurt(session)) {
        retreat = true;
        ctx.log(`Taking damage; calling ${memo.name} back`);
        break;
      }
      const foe = session.world.entities.get(hostile.serial);
      if (!foe?.position) break;
      if (archer && ranged) {
        const gap = distance(ctx.position(), foe.position);
        if (gap < 3 || gap > ranged.range) {
          const spot = await combatPosition({
            session,
            terrain: ctx.terrain,
            origin: ctx.position(),
            target: foe,
            threats: threatsNear(session, ctx.position(), 12).filter(
              (entity) => entity.serial !== foe.serial && entity.serial !== pet.serial
            ),
            range: ranged.range - 1,
            check: ctx.check
          });
          if (!spot) {
            retreat = true;
            break;
          }
          await ctx.navigate(spot, 0);
        }
        if (!ctx.count(ranged.ammo)) {
          retreat = true;
          break;
        }
      }
      await session.inspect(pet.serial).catch(() => {});
      const now = session.world.entities.get(pet.serial);
      if (!now?.position || session.world.deaths.has(pet.serial)) break;
      if (
        now.hits === undefined ||
        !now.maxHits ||
        now.hits < now.maxHits * 0.3 ||
        (now.hits < now.maxHits * 0.5 && ctx.count(bandage) === 0)
      ) {
        retreat = true;
        break;
      }
      if (now.hits < now.maxHits * 0.7) await veterinary(ctx, now);
      await Bun.sleep(1500);
    }
    if (session.world.deaths.has(hostile.serial)) ctx.progress.petKills = (ctx.progress.petKills ?? 0) + 1;
  } finally {
    if (session.phase === 'ready') {
      if (session.world.target) session.target(null);
      if (archer) session.setWarMode(false);
      session.say('all follow me');
    }
  }
  if (retreat) {
    const bank = pickLocation(ctx.city, 'banker');
    if (bank) await urgentAction(session, 'escape', () => ctx.navigate(bank, 3));
  }
  return true;
}

export const fightWithPet = (...args: Parameters<typeof petEncounter>) =>
  urgentAction(args[0].session, 'combat', () => petEncounter(...args));
