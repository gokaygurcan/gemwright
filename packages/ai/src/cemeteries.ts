import { absence } from './absence';
import { urgentAction } from './action-purpose';
import { strandedAt, withinReach } from './areas';
import { Blocked } from './blocked';
import { chaosOf } from './chaos';
import { fightConfidence, strikesFromAfar } from './fight-confidence';
import { Ambushed, type FighterContext, observedThreat, Retreat } from './fighter-context';
import { combatSkill, goldOf, readyFor, teaches } from './fighter-prey';
import { type Gate, moongates, nearestGate } from './gates';
import { haven, onHaven, prefersHaven } from './haven';
import { lasting } from './lasting';
import { monsters } from './monster-reference';
import { travelByMoongate } from './moongate';
import { distance } from './navigation';
import { spawnGrounds as buildGrounds } from './spawn-grounds';
import type { Rect, Spawner } from './spawns';
import { residentsNear } from './spread';
import { learnedPlaceCost } from './strategy-learning';
import { placeAllowed } from './towns';
import { WALKING_LIMIT } from './tuning';

// Trammel cemeteries (uo.com "Cemeteries" list) that hold undead spawners on the pinned shard
// (Spawns/trammel.xml Graveyards#0-#5). Nujel'm has no undead spawner and is not listed.
// `gate` is the public moongate a fighter travels through when the cemetery is far away.
export interface Ground {
  name: string;
  center: { x: number; y: number };
  gate: Gate;
  patrol?: { x: number; y: number }[];
  // Overland spawns (spawn-grounds.ts): how far they reach and what lives there.
  radius?: number;
  creatures?: Record<string, number>;
}
const cemeteryPlaces: Ground[] = [
  {
    name: 'Britain',
    center: { x: 1369, y: 1475 },
    gate: 'britain',
    patrol: [
      { x: 1375, y: 1485 },
      { x: 1355, y: 1475 },
      { x: 1375, y: 1455 },
      { x: 1395, y: 1475 }
    ]
  },
  { name: 'Vesper', center: { x: 2758, y: 867 }, gate: 'minoc' },
  { name: 'Yew', center: { x: 722, y: 1119 }, gate: 'yew' },
  { name: 'Jhelom', center: { x: 1285, y: 3731 }, gate: 'jhelom' },
  { name: 'Moonglow', center: { x: 4545, y: 1317 }, gate: 'moonglow' },
  // Liches spawn here; the opponent gate keeps ordinary fighters away from them.
  { name: 'Cove', center: { x: 2438, y: 1099 }, gate: 'minoc' },
  // The undead of Old Haven on Haven Island, where New Haven's residents start (haven.ts).
  { name: 'New Haven', center: { x: 3650, y: 2510 }, gate: 'newhaven' }
];
export const cemeteries: Ground[] = cemeteryPlaces.map((ground) => ({ ...ground }));
export const HUNTING_RADIUS = 65;
// The cemeteries, and every overland place where creatures that attack on sight spawn outside towns
// and dungeons (orcs, harpies, trolls and lizardmen west of Britain, and hundreds more), and Haven
// Island's: all from the shard's own spawners, read at start (shard-world.ts). A fighter moves on to
// one its skills meet when its cemetery runs dry.
export const grounds: Ground[] = [];
export function useShardSpawns(world: { spawners: Spawner[]; regions: Rect[] }) {
  const built = buildGrounds(world.spawners, world.regions, cemeteryPlaces, HUNTING_RADIUS);
  for (const cemetery of cemeteries) cemetery.creatures = built.cemeteries[cemetery.name];
  const overland = built.grounds.map((g) => ({ ...g, gate: nearestGate(g.center) }));
  const island = haven.grounds.map((g) => ({ ...g, gate: 'newhaven' as const }));
  // A cemetery with no spawner of its own on this shard has nothing to hunt: it is no ground.
  const spawning = cemeteries.filter((cemetery) => cemetery.creatures);
  grounds.splice(0, grounds.length, ...spawning, ...overland, ...island);
}
const reach = (ground: Ground) => ground.radius ?? HUNTING_RADIUS;
// Residents at a cemetery beyond which a fighter moving on looks elsewhere.
const CROWDED = 8;
// Farther than this, a route is taken through a moongate instead of walked.

// A stranded fighter hunts where it stands (areas.ts): a ground named after its spot.
const LOCAL = 'where I am stranded near ';
export const groundOf = (trip: FighterContext['trip']): Ground => {
  if (trip.ground?.startsWith(LOCAL)) {
    const [x = 0, y = 0] = trip.ground.slice(LOCAL.length).split(',').map(Number);
    return { name: trip.ground, center: { x, y }, gate: nearestGate({ x, y }), radius: 16 };
  }
  return grounds.find((ground) => ground.name === trip.ground) ?? (cemeteries[0] as Ground);
};

export const nearAnyGround = (point: { x: number; y: number }) =>
  grounds.some((ground) => distance(point, ground.center) < reach(ground));

export const atGround = (ctx: FighterContext) =>
  distance(ctx.position(), groundOf(ctx.trip).center) < reach(groundOf(ctx.trip));

// Four points around the ground's centre, wider on an overland spawn than in a cemetery.
export const patrolPoints = (ground: Ground) => {
  const scale = ground.radius ? ground.radius / 16 : 1;
  return (
    ground.patrol ??
    [
      [6, 10],
      [-10, 0],
      [6, -10],
      [10, 0]
    ].map(([dx, dy]) => ({
      x: ground.center.x + Math.round((dx ?? 0) * scale),
      y: ground.center.y + Math.round((dy ?? 0) * scale)
    }))
  );
};

// Where to hunt next once the current ground runs dry: the cemeteries, and every overland spawn
// whose creatures this fighter's skills meet for at least half of what lives there (fighter-prey.ts
// `readyFor`: a fight costs at most half its health). Nearer grounds, ones whose creatures still
// teach it (`teaches`) and quieter ones (spread.ts) are preferred, gold breaks ties; with more
// combat skill the plain cemeteries lose their pull, and chaos shuffles the order a little. A
// crowded ground is passed over.
// Whether a ground's creatures suit this fighter: it meets at least half of what lives there, and
// none that attacks on sight is beyond it. Such a creature attacks whoever it sees, chosen opponent
// or not (the Cove graveyard's lich, Haven Island's ettins): a ground with one waits until the
// fighter could take it on, whatever else lives there.
export function groundFits(ctx: FighterContext, ground: Ground): boolean {
  // Only around the cities the shard allows (gemwright.json ai.cities).
  if (!ground.name.startsWith(LOCAL) && !placeAllowed(ground.center)) return false;
  const kinds = Object.entries(ground.creatures ?? {});
  const total = kinds.reduce((n, [, count]) => n + count, 0);
  const fit = kinds.filter(([type]) => readyFor(ctx, type)).reduce((n, [, count]) => n + count, 0);
  if (ground.creatures && fit * 2 < total) return false;
  return !kinds.some(([type]) => monsters.find((m) => m.type === type)?.aggressive && !readyFor(ctx, type));
}

export function nextGround(ctx: FighterContext): string {
  const here = ctx.position();
  const current = groundOf(ctx.trip).name;
  // The skill it fights with, not its highest: a maxed Anatomy says nothing about its sword arm.
  const skill = combatSkill(ctx);
  // A Young resident of New Haven prefers Haven Island's grounds (haven.ts), as new players do.
  const young = prefersHaven(ctx.session);
  const options = grounds.flatMap((ground) => {
    const present = residentsNear(ground.center, reach(ground), ctx.serial);
    if (ground.name === current || present >= CROWDED || absence(ctx.serial).seen('ground', ground.center)) return [];
    // Only grounds it can walk to, or reach through a moongate (areas.ts): never one out at sea.
    if (!withinReach(here, ground.center)) return [];
    if (!groundFits(ctx, ground)) return [];
    const kinds = Object.entries(ground.creatures ?? {});
    const total = kinds.reduce((n, [, count]) => n + count, 0);
    const gold = kinds.reduce((n, [type, count]) => n + goldOf(type) * count, 0) / Math.max(1, total);
    // Skill comes from creatures near the character's own skill: a ground where most of them still
    // teach is worth up to 400 tiles more walking; gold only breaks ties.
    const teaching = kinds.filter(([type]) => teaches(ctx, type)).reduce((n, [, count]) => n + count, 0);
    const cost =
      distance(here, ground.center) +
      learnedPlaceCost(ctx.checkpoint, ctx.session.world.map ?? 1, ground.center) +
      (ground.creatures ? 0 : Math.max(0, skill - 60) * 8) +
      present * 40 -
      (total ? (teaching / total) * 400 : 0) -
      Math.min(gold, 100) +
      Math.random() * 300 * chaosOf(ctx.session) +
      (young && !onHaven(ground.center) ? 300 : 0);
    return [{ name: ground.name, cost }];
  });
  return options.sort((a, b) => a.cost - b.cost)[0]?.name ?? (young ? 'New Haven' : 'Britain');
}

// Reaches a far point the way a player would: through the moongate nearest to it, then on foot.
export async function travelNear(ctx: FighterContext, point: { x: number; y: number }, range: number) {
  const gate = nearestGate(point);
  const viaGate = async () => {
    if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
  };
  if (distance(ctx.position(), point) > WALKING_LIMIT) await viaGate();
  try {
    await ctx.navigate(point, range);
  } catch (error) {
    // Close but across water (an island town from the shore): take the gate, then walk.
    if (!(error instanceof Blocked) || error.reason !== 'unreachable' || distance(ctx.position(), moongates[gate]) <= 2)
      throw error;
    await viaGate();
    await ctx.navigate(point, range);
  }
}

export async function travelToGround(ctx: FighterContext, overland = false) {
  // Stranded (no moongate in its walkable area): it hunts right here until help moves it; once
  // out, a real ground again.
  const here = ctx.position();
  // First a way out, as a player would (Recall, else the stuck menu; moongate.ts), every half hour.
  const way = lasting('stranded-escape', ctx.serial);
  if (strandedAt(here) && !way.active('next')) {
    way.set('next', Date.now() + 30 * 60_000);
    await travelByMoongate(ctx, nearestGate(here)).catch(() => {});
  }
  if (strandedAt(ctx.position())) {
    ctx.trip.ground = `${LOCAL}${here.x},${here.y}`;
    ctx.persist();
    ctx.phase('stranded-hunting', 'No way out on foot; hunting where I stand');
    return;
  }
  // A ground chosen before (a saved trip) is held to the same test as a new choice.
  if (ctx.trip.ground?.startsWith(LOCAL) || !groundFits(ctx, groundOf(ctx.trip))) {
    ctx.trip.ground = nextGround(ctx);
    ctx.persist();
  }
  const ground = groundOf(ctx.trip);
  ctx.phase(
    'travelling-to-graveyard',
    `Heading to ${ground.creatures ? `the ${ground.name}` : `the ${ground.name} cemetery`}`
  );
  if (!overland && distance(ctx.position(), ground.center) > WALKING_LIMIT) await travelByMoongate(ctx, ground.gate);
  try {
    await ctx.navigate(ground.center, 3);
  } catch (error) {
    // A cemetery across water from here: through its moongate, then on foot.
    if (overland || !(error instanceof Blocked) || error.reason !== 'unreachable') throw error;
    await travelByMoongate(ctx, ground.gate);
    try {
      await ctx.navigate(ground.center, 3);
    } catch (again) {
      // Not even from its moongate: another ground next time, not the same failed walk.
      if (again instanceof Blocked && again.reason === 'unreachable') {
        ctx.trip.ground = nextGround(ctx);
        ctx.persist();
        ctx.log(`Cannot reach the ${ground.name}; hunting at the ${groundOf(ctx.trip).name} instead`);
      }
      throw again;
    }
  }
}

// Town trips (bank, vendors, healer) go to the fighter's home town; from a distant cemetery the
// way back is the moongate nearest home.
// The way home is itself the escape: being hit on the way must not cancel it (fighter.ts check()
// retreats on damage outside combat, which would restart this trip on every step).
export async function returnHome(ctx: FighterContext) {
  const home = ctx.home.town;
  if (distance(ctx.position(), home) <= WALKING_LIMIT) return;
  const gate = nearestGate(home);
  if (distance(ctx.position(), moongates[gate]) > 2)
    await urgentAction(ctx.session, 'escape', () => travelByMoongate(ctx, gate));
}

// What is swinging at it first (the server's swing packet names attacker and target), else the
// nearest threat within 8 tiles (fighter.ts check).
const attackerNear = (ctx: FighterContext) => {
  const swinging = ctx
    .nearby()
    .find(
      (m) =>
        !ctx.session.world.deaths.has(m.serial) &&
        ctx.session.world.swings.get(m.serial)?.target === ctx.serial &&
        Date.now() - (ctx.session.world.swings.get(m.serial)?.at ?? 0) < 3000
    );
  if (swinging) return { mobile: swinging, engaged: true };
  const near = ctx
    .nearby()
    .filter(
      (m) =>
        m.position &&
        !ctx.session.world.deaths.has(m.serial) &&
        observedThreat(m, ctx.session.world.combatant) &&
        distance(ctx.position(), m.position) < 8
    )
    .sort(
      (a, b) =>
        distance(ctx.position(), a.position ?? ctx.position()) - distance(ctx.position(), b.position ?? ctx.position())
    )[0];
  if (near) return { mobile: near, engaged: false };
  // Nothing swings and nothing is close: a caster or archer in sight is what hurts it.
  const afar = ctx
    .nearby()
    .filter(
      (m) =>
        m.position &&
        !ctx.session.world.deaths.has(m.serial) &&
        observedThreat(m, ctx.session.world.combatant) &&
        strikesFromAfar(m) &&
        distance(ctx.position(), m.position) <= 14
    )
    .sort(
      (a, b) =>
        distance(ctx.position(), a.position ?? ctx.position()) - distance(ctx.position(), b.position ?? ctx.position())
    )[0];
  return afar && { mobile: afar, engaged: true };
};

// Hurt twice within half an hour on the same ground: it is beyond it for now, so another one.
export function retreatedFrom(ctx: FighterContext) {
  const ground = groundOf(ctx.trip).name;
  const recent = (ctx.checkpoint.retreats ?? []).filter((r) => r.ground === ground && r.at > Date.now() - 1_800_000);
  ctx.checkpoint.retreats = [...recent, { ground, at: Date.now() }];
  if (!recent.length) return;
  ctx.trip.ground = nextGround(ctx);
  ctx.checkpoint.retreats = [];
  ctx.log(`Hurt twice at the ${ground}; hunting at the ${groundOf(ctx.trip).name} instead`);
}

// Hurt outside a fight: it turns on the attacker when it expects to walk away (fight-confidence.ts),
// otherwise it gets to safety.
export function hurtOnTheWay(ctx: FighterContext) {
  const attacker = attackerNear(ctx);
  if (attacker && !ctx.state.inCombat && fightConfidence(ctx, attacker.mobile, attacker.engaged).ok)
    throw new Ambushed(attacker.mobile);
  // A scratch from something unseen (poison, a far archer) is no reason to walk home: a player
  // carries on while healthy and leaves only when it starts to tell.
  if (!attacker && ctx.status().hits >= ctx.status().maxHits * 0.5) return;
  throw new Retreat('Taking damage outside combat; returning to safety even when the attacker is unknown');
}

// Attacked on the way (hurtOnTheWay): it fights the attacker now, wherever this is. True when it did.
export async function fightBack(
  ctx: FighterContext,
  attacker: Ambushed['attacker'] | undefined,
  defeat: (opponent: Ambushed['attacker']) => Promise<void>
) {
  if (!attacker || !ctx.session.world.entities.has(attacker.serial) || ctx.session.world.deaths.has(attacker.serial))
    return false;
  ctx.phase('fighting-back', `Attacked on the way; fighting ${attacker.name ?? 'the attacker'}`);
  await defeat(attacker);
  return true;
}
