import { HUMAN_BODIES } from '@gemwright/common/bodies';
import { bandage } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { urgentAction } from './action-purpose';
import { threatsNear } from './danger';
import { packItems } from './inventory';
import { pickLocation, townAt } from './locations';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// Mending, as players do it. A resident just back from the dead has a handful of hit points and
// dies to the first blow, so it heals before going back to work: bandages with Healing, Heal or
// Greater Heal with Magery, or a rest where it stands. And a healer or mage who sees someone
// hurt nearby (another resident or a player, never a criminal or murderer) patches them up.
type Ctx = {
  session: PlayerSession;
  check: () => void;
  phase: (phase: string, note: string) => void;
  navigate: (point: { x: number; y: number }, range: number) => Promise<unknown>;
  backpack: () => number;
};
const [garlic, ginseng, mandrake, silk] = [0x0f84, 0x0f85, 0x0f86, 0x0f8d];
const HEAL = { id: 4, mana: 4, reagents: [garlic, ginseng, silk], min: 0 };
const GREATER_HEAL = { id: 29, mana: 11, reagents: [garlic, ginseng, mandrake, silk], min: 50 };
const BANDAGE_MS = 7000;
const lastAid = new WeakMap<PlayerSession, number>();

const skill = (session: PlayerSession, name: string) => session.world.skills.get(skillId(name))?.value ?? 0;
const pack = (ctx: Ctx) => packItems(ctx.session, ctx.backpack());
const has = (ctx: Ctx, graphic: number) => pack(ctx).some((item) => item.graphic === graphic);

function spellFor(ctx: Ctx) {
  const mana = ctx.session.world.status?.mana ?? 0;
  return [GREATER_HEAL, HEAL].find(
    (spell) =>
      skill(ctx.session, 'Magery') >= Math.max(30, spell.min) &&
      mana >= spell.mana &&
      spell.reagents.every((r) => has(ctx, r))
  );
}

// One heal on `who` (a serial; the resident itself by default). True when one was started.
async function healOnce(ctx: Ctx, who: number): Promise<boolean> {
  const { session } = ctx;
  if (session.world.target) return false;
  const cloth = skill(session, 'Healing') >= 10 ? pack(ctx).find((item) => item.graphic === bandage) : undefined;
  const spell = spellFor(ctx);
  if (cloth) session.use(cloth.serial);
  else if (spell) session.useSkill(spell.id, true);
  else return false;
  await session.waitFor(() => session.world.target !== null, 'heal cursor', 3000).catch(() => {});
  if (!session.world.target) return false;
  const mobile = session.world.entities.get(who);
  session.target({ serial: who, x: 0, y: 0, z: 0, graphic: mobile?.graphic ?? 0 });
  await Bun.sleep(cloth ? BANDAGE_MS : 2500);
  return true;
}

const ratio = (session: PlayerSession) => {
  const status = session.world.status;
  return status ? status.hits / Math.max(1, status.maxHits) : 1;
};

// Badly hurt (as after a resurrection): heal to most of its health before anything else, four minutes at most.
// With nothing to heal with it rests (natural regeneration), out of reach of monsters.
export async function mendAfterDeath(ctx: Ctx, log: (message: string) => void, home = 'Britain') {
  const { session } = ctx;
  if (ratio(session) >= 0.5) return;
  ctx.phase(
    'mending',
    `Healing before going back to work (${session.world.status?.hits}/${session.world.status?.maxHits})`
  );
  const until = Date.now() + 4 * 60_000;
  while (Date.now() < until && ratio(session) < 0.8) {
    ctx.check();
    // Never mends among monsters: first to the nearest town bank, where it is safe.
    const here = session.world.position;
    if (here && threatsNear(session, here, 14).length) {
      const bank = pickLocation(townAt(here, home), 'banker', here);
      ctx.phase('mending', 'Monsters about; going somewhere safe to heal');
      if (bank) await urgentAction(session, 'escape', () => ctx.navigate(bank, 3)).catch(() => {});
    }
    const me = session.world.serial;
    if (me === null || !(await healOnce(ctx, me))) await Bun.sleep(3000);
    await session.refreshStatus().catch(() => {});
  }
  log(`Mended to ${session.world.status?.hits}/${session.world.status?.maxHits} before going back to work`);
}

// Someone hurt within sight, who it can heal: once every ten seconds at most. True when it helped.
export async function healOthers(ctx: Ctx, log: (message: string) => void): Promise<boolean> {
  const { session } = ctx;
  const here = session.world.position;
  if (!here || Date.now() - (lastAid.get(session) ?? 0) < 10_000) return false;
  const bandages = skill(session, 'Healing') >= 40 && has(ctx, bandage);
  if (!bandages && !spellFor(ctx)) return false;
  const hurt = [...session.world.entities.values()].find(
    (m: Entity) =>
      m.kind === 'mobile' &&
      m.serial !== session.world.serial &&
      HUMAN_BODIES.has(m.graphic) &&
      (m.notoriety === 1 || m.notoriety === 2) &&
      !!m.position &&
      !!m.maxHits &&
      (m.hits ?? m.maxHits) / m.maxHits < 0.5 &&
      (m.hits ?? 0) > 0 &&
      Date.now() - (m.healthAt ?? 0) < 30_000 &&
      distance(here, m.position) <= 10
  );
  if (!hurt?.position || threatsNear(session, hurt.position, 6).length) return false;
  lastAid.set(session, Date.now());
  ctx.phase('healing-other', `Healing ${hurt.name ?? 'someone'}, who is badly hurt`);
  // Bandages need to be next to them; a spell reaches across the room.
  if (bandages) await ctx.navigate(hurt.position, 1).catch(() => {});
  if (!(await healOnce(ctx, hurt.serial))) return false;
  log(`Healed ${hurt.name ?? 'someone'} (${hurt.hits}/${hurt.maxHits})`);
  return true;
}
