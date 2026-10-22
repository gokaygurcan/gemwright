import type { DungeonContext, DungeonRun } from './dungeon-context';
import { musterOf, partyChat, partySay } from './dungeon-party';
import { dungeonWalker } from './dungeon-tools';
import { type Dungeon, dungeonNamed } from './dungeons';
import { ghosts } from './fighter-context';
import { resurrectionButton } from './fighter-recovery';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import { skillId } from './skills';

// Deaths in a dungeon. A ghost in a party manifests (war mode, so the living can see it), asks for
// a resurrection in party chat and waits by its corpse; a member with Healing and Anatomy at 80.0
// and bandages (ServUO Bandage.cs), or with the Resurrection spell, answers and raises it, and the
// character takes back its corpse and carries on. Nobody to answer: a leader hands the party to a
// living member, and the ghost climbs out to a healer. A character that recovers its own corpse
// later goes back down for it over the stairways while the corpse may still be there (player
// corpses decay after seven minutes).
const BANDAGE = 0x0e21;
const CORPSE = 0x2006;
const OWNER = 1046414; // "the remains of ~1_NAME~"
const ANSWER_MS = 20_000;
const RAISE_MS = 90_000;
const CORPSE_MS = 8 * 60_000;

const backpack = (ctx: DungeonContext) =>
  ctx.session.world.childrenOf(ctx.serial).find((item) => item.layer === Layer.Backpack)?.serial;
const bandages = (ctx: DungeonContext) => {
  const pack = backpack(ctx);
  return pack ? ctx.session.world.childrenOf(pack).filter((item) => item.graphic === BANDAGE) : [];
};
const skill = (ctx: DungeonContext, name: string) => ctx.session.world.skills.get(skillId(name))?.value ?? 0;
// Resurrection (ServUO ResurrectionSpell): 8th circle, so Magery 80.0 at least (MagerySpell
// GetCastSkills), 50 mana, bloodmoss, garlic and ginseng, the caster next to the ghost, and the
// spell in the book; "You do not have that spell!" rules it out for this character.
const RESURRECTION = 59;
const NO_SPELL = 500015;
const SPELLBOOK = 0x0efa;
const reagents = [0x0f7b, 0x0f84, 0x0f85];
const withoutSpell = new Set<number>();
const carried = (ctx: DungeonContext) => {
  const pack = backpack(ctx);
  return pack ? ctx.session.world.childrenOf(pack) : [];
};
// How this character can raise a ghost: a bandage, the Resurrection spell, or not at all.
export function canRaise(ctx: DungeonContext): 'bandage' | 'spell' | undefined {
  if (ctx.dead()) return undefined;
  if (skill(ctx, 'Healing') >= 80 && skill(ctx, 'Anatomy') >= 80 && bandages(ctx).length > 0) return 'bandage';
  const items = carried(ctx);
  if (
    skill(ctx, 'Magery') >= 80 &&
    !withoutSpell.has(ctx.serial) &&
    (ctx.session.world.status?.mana ?? 0) >= 50 &&
    items.some((item) => item.graphic === SPELLBOOK) &&
    reagents.every((graphic) => items.some((item) => item.graphic === graphic))
  )
    return 'spell';
  return undefined;
}
const isGhostSerial = (ctx: DungeonContext, serial: number) =>
  ghosts.has(ctx.session.world.entities.get(serial)?.graphic ?? 0);

// The ghost's side: true when a party healer brought it back.
async function waitForRaise(ctx: DungeonContext, run: DungeonRun): Promise<boolean> {
  const m = musterOf(run.party?.id);
  if (!m) return false;
  // With every other member dead or gone the party is over: nobody is left to answer.
  const living = [...m.members.keys()].some(
    (serial) => serial !== ctx.serial && !m.gone.has(serial) && !isGhostSerial(ctx, serial)
  );
  if (!living) {
    m.status = 'ended';
    partySay(ctx, 'all dead, everyone head out');
    return false;
  }
  const { session } = ctx;
  const asked = new Date().toISOString();
  session.setWarMode(true);
  partySay(ctx, `res pls at ${ctx.position().x},${ctx.position().y}`);
  ctx.phase('dungeon-ghost', 'Manifested by my corpse, asking the party for a resurrection');
  const answered = () => partyChat(ctx, asked).some((e) => e.serial !== ctx.serial && /coming/i.test(e.text ?? ''));
  let until = Date.now() + ANSWER_MS;
  while (Date.now() < until && ctx.dead()) {
    ctx.check();
    if (answered()) until = Math.max(until, Date.now() + RAISE_MS);
    const offer = [...session.world.gumps.values()].find((gump) => resurrectionButton(gump.layout) !== undefined);
    if (offer) session.replyGump(offer.serial, offer.id, resurrectionButton(offer.layout) ?? 1, []);
    await Bun.sleep(1000);
  }
  session.setWarMode(false);
  return !ctx.dead();
}

// Finds this character's corpse nearby, empties it into the pack and dresses again.
export async function reclaimCorpse(ctx: DungeonContext): Promise<boolean> {
  const { session } = ctx;
  const name = session.world.entities.get(ctx.serial)?.name;
  const pack = backpack(ctx);
  if (!name || !pack) return false;
  for (const body of [...session.world.entities.values()]) {
    if (body.graphic !== CORPSE || !body.position || distance(ctx.position(), body.position) > 18) continue;
    await session.inspectProperties(body.serial).catch(() => {});
    const owned = session.world.entities
      .get(body.serial)
      ?.properties?.some((p) => p.cliloc === OWNER && p.arguments === name);
    if (!owned) continue;
    await ctx.navigate(body.position, 1);
    const before = session.world.received.get(0x3c) ?? 0;
    session.use(body.serial);
    await session.waitFor(() => (session.world.received.get(0x3c) ?? 0) > before, 'corpse contents', 4000);
    for (const item of session.world.childrenOf(body.serial)) {
      ctx.check();
      await session.moveItem(item.serial, pack);
      await Bun.sleep(700);
    }
    await ctx.dress();
    ctx.phase('corpse-recovered', 'Took back everything from my corpse');
    return true;
  }
  return false;
}

// A ghost in the dungeon: raised by the party, or out to a healer. Returns whether it is alive here.
export async function handleDeath(ctx: DungeonContext, run: DungeonRun, dungeon: Dungeon, ownCorpse: boolean) {
  run.deaths++;
  ctx.persist();
  const site = { ...ctx.position() };
  ctx.setRecovering(true);
  try {
    if (await waitForRaise(ctx, run)) {
      await reclaimCorpse(ctx);
      partySay(ctx, 'ty, back on my feet');
      return true;
    }
    const m = musterOf(run.party?.id);
    if (m && run.party?.role === 'leader') {
      // The party goes on under a living member; it learns so in party chat.
      const heir = [...m.members.entries()].find(
        ([serial]) => serial !== ctx.serial && !m.gone.has(serial) && !isGhostSerial(ctx, serial)
      );
      if (heir) {
        m.leader = heir[0];
        partySay(ctx, `${heir[1]} leads now, i'm going for a res`);
      } else m.status = 'ended';
    }
    m?.gone.add(ctx.serial);
    partySay(ctx, 'i died, heading out');
    await dungeonWalker(ctx, () => false).climbOut(dungeon, 'Climbing out as a ghost');
    if (!ownCorpse)
      ctx.checkpoint.dungeonCorpse = { dungeon: dungeon.name, ...site, diedAt: new Date().toISOString(), attempts: 0 };
    ctx.persist();
    return false;
  } finally {
    ctx.setRecovering(false);
  }
}

// The healer's side: answers "res pls" from a member it can reach on this floor. True when it acted.
const heard = new WeakMap<object, { at: string; requests: Map<number, { x: number; y: number; at: number }> }>();
export async function rescueStep(ctx: DungeonContext, run: DungeonRun): Promise<boolean> {
  if (!run.party) return false;
  const memo = heard.get(ctx.session) ?? { at: run.startedAt, requests: new Map() };
  heard.set(ctx.session, memo);
  for (const entry of partyChat(ctx, memo.at)) {
    memo.at = entry.at;
    const ask = /res pls at (\d+),(\d+)/.exec(entry.text ?? '');
    if (ask && entry.serial !== ctx.serial)
      memo.requests.set(entry.serial, { x: Number(ask[1]), y: Number(ask[2]), at: Date.now() });
  }
  const method = canRaise(ctx);
  if (!method) return false;
  for (const [serial, request] of memo.requests) {
    if (Date.now() - request.at > RAISE_MS || (ctx.session.world.entities.has(serial) && !isGhostSerial(ctx, serial))) {
      memo.requests.delete(serial);
      continue;
    }
    if (distance(ctx.position(), request) > 40) continue;
    partySay(ctx, 'coming');
    ctx.phase('dungeon-rescue', `Going to resurrect a party member at ${request.x},${request.y}`);
    const walker = dungeonWalker(ctx, () => false);
    await walker.walk(request, 1);
    const ghost = ctx.session.world.entities.get(serial);
    if (!ghost?.position || distance(ctx.position(), ghost.position) > 1) return true;
    if (method === 'bandage') {
      const bandage = bandages(ctx)[0];
      if (!bandage) return true;
      ctx.session.use(bandage.serial);
      await ctx.session.waitFor(() => ctx.session.world.target !== null, 'bandage cursor', 3000);
    } else {
      const seen = new Set(ctx.session.world.journal);
      ctx.session.useSkill(RESURRECTION, true);
      // Eighth-circle casting takes about three seconds before the target cursor appears.
      await ctx.session
        .waitFor(
          () =>
            ctx.session.world.target !== null ||
            ctx.session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL),
          'resurrection cursor',
          6000
        )
        .catch(() => {});
      if (ctx.session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL)) {
        withoutSpell.add(ctx.serial);
        ctx.log('Resurrection is not in my spellbook');
        return true;
      }
      // A fizzle leaves no cursor; the request stands and the next step tries again.
      if (!ctx.session.world.target) return true;
    }
    ctx.phase('dungeon-rescue', `Raising a party member with ${method === 'spell' ? 'Resurrection' : 'a bandage'}`);
    ctx.session.target({ serial, x: 0, y: 0, z: 0, graphic: ghost.graphic });
    // The ghost accepts the offer on its side; bandaging takes several seconds.
    const until = Date.now() + 20_000;
    while (Date.now() < until && isGhostSerial(ctx, serial)) {
      ctx.check();
      await Bun.sleep(1000);
    }
    if (!isGhostSerial(ctx, serial)) memo.requests.delete(serial);
    return true;
  }
  return false;
}

// After a resurrection on the surface: back down for the corpse while it may still be there.
export async function recoverDungeonCorpse(ctx: DungeonContext) {
  const corpse = ctx.checkpoint.dungeonCorpse;
  const dungeon = dungeonNamed(corpse?.dungeon);
  if (!corpse || !dungeon || ctx.dead()) return;
  if (Date.now() - Date.parse(corpse.diedAt) > CORPSE_MS || corpse.attempts >= 2) {
    ctx.phase('abandoning-corpse', `My corpse in ${dungeon.name} has decayed by now`);
    delete ctx.checkpoint.dungeonCorpse;
    ctx.persist();
    return;
  }
  corpse.attempts++;
  ctx.persist();
  const walker = dungeonWalker(ctx, () => false);
  try {
    ctx.phase('recovering-corpse', `Going back into ${dungeon.name} for my corpse`);
    await walker.travelTo(corpse, 3);
    if (!(await reclaimCorpse(ctx))) ctx.log('My corpse is no longer there');
    delete ctx.checkpoint.dungeonCorpse;
  } catch (error) {
    if (ctx.session.phase !== 'ready' || ctx.dead()) throw error;
    ctx.log(`Corpse recovery failed: ${error instanceof Error ? error.message : error}`);
  }
  ctx.persist();
  await walker.climbOut(dungeon);
}
