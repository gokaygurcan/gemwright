import { readFileSync } from 'node:fs';

import { gold } from '@gemwright/common/items';

import { tally } from './activity';
import { nearAnyGround } from './cemeteries';
import { pickLocation } from './locations';
import { type Gate, moongates, nearestGate, travelByMoongate } from './moongate';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';

// Escort quests, a broke player's first income (ServUO BaseEscortable): townsfolk who want to go
// to another town (nobles, mages, seekers of adventure, merchants) pay 500 to 1,000 gold on
// arrival. The context menu's "Ask destination" (6100) makes the NPC say "I am looking to go to
// <town>, will you take me?"; "Accept escort" (6101) makes it follow. It pays once it stands in
// the destination's town region (cliloc 1042809), and gives up if its escorter is out of sight for
// two minutes. A follower within three tiles goes through a moongate with its master
// (BaseCreature.TeleportPets). Only trips from gate to gate are taken: a town near a moongate on
// both ends, so the walk is short and inside guarded towns.
type Ctx = Pick<
  ProfessionContext,
  'session' | 'serial' | 'position' | 'navigate' | 'check' | 'phase' | 'log' | 'count'
>;

const ASK = 3006100;
const ACCEPT = 3006101;
const ARRIVED = 1042809;
// Escortable bodies are ordinary humans; their name property ends with their role.
const ESCORTS = /\b(noble|mage|seeker of adventure|merchant|peasant|healer|bride|groom|messenger)\s*$/i;
// Each destination's town, by the name the NPC says, and how far its bank is from its moongate.
const towns: Record<string, string> = {
  Britain: 'Britain',
  Jhelom: 'Jhelom',
  Minoc: 'Minoc',
  Trinsic: 'Trinsic',
  Vesper: 'Vesper',
  Yew: 'Yew',
  'Skara Brae': 'Skara Brae',
  Moonglow: 'Moonglow'
};
const GATE_WALK = 250;
const spots = (
  JSON.parse(readFileSync(new URL('../locations/escorts.json', import.meta.url), 'utf8')) as {
    spots: { x: number; y: number }[];
  }
).spots;
const refused = new WeakMap<object, Map<number, number>>();
// Anyone may take an escort, but the penniless come first: residents with no gold at all register
// here, and others leave the escorts around them alone.
const broke = new Map<number, { x: number; y: number; at: number }>();
const lastTry = new WeakMap<object, number>();

// Between turns: a resident with no gold looks for an escort every few minutes, anyone else every
// twenty, and never next to a penniless one. True when it was paid.
export async function escortOpportunity(ctx: Ctx, funds: number): Promise<boolean> {
  const here = ctx.position();
  if (funds <= 0) broke.set(ctx.serial, { ...here, at: Date.now() });
  else broke.delete(ctx.serial);
  const wait = funds <= 0 ? 3 * 60_000 : 20 * 60_000;
  if (Date.now() - (lastTry.get(ctx.session) ?? 0) < wait) return false;
  lastTry.set(ctx.session, Date.now());
  if (
    funds > 0 &&
    [...broke].some(
      ([serial, at]) => serial !== ctx.serial && Date.now() - at.at < 10 * 60_000 && distance(at, here) <= 30
    )
  )
    return false;
  if (await escortForPay(ctx)) return true;
  // The penniless go looking where escorts spawn (locations/escorts.json): the nearest few spots
  // within walking distance, never one inside a monster spawn.
  if (funds > 0) return false;
  const near = spots
    .filter((spot) => distance(here, spot) <= 150 && !nearAnyGround(spot))
    .sort((a, b) => distance(here, a) - distance(here, b))
    .slice(0, 3);
  for (const spot of near) {
    ctx.phase('escort-search', `Looking for someone to escort near ${spot.x},${spot.y}`);
    await ctx.navigate(spot, 4).catch(() => {});
    if (await escortForPay(ctx)) return true;
  }
  return false;
}

const destinationOf = (ctx: Ctx, escort: number, since: Set<unknown>) =>
  ctx.session.world.journal
    .filter((entry) => !since.has(entry) && entry.serial === escort)
    .map((entry) => /looking to go to (.+?), will you take me/i.exec(entry.text ?? '')?.[1])
    .find(Boolean);

// One escort, start to payment; true when it was paid.
export async function escortForPay(ctx: Ctx): Promise<boolean> {
  const { session, phase, log } = ctx;
  const skip = refused.get(session) ?? new Map<number, number>();
  refused.set(session, skip);
  const here = ctx.position();
  const candidates = [...session.world.entities.values()]
    .filter(
      (m) =>
        m.kind === 'mobile' &&
        m.position &&
        distance(here, m.position) <= 18 &&
        (skip.get(m.serial) ?? 0) < Date.now() &&
        m.serial !== ctx.serial
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))
    .slice(0, 12);
  const seen: string[] = [];
  for (const npc of candidates) {
    ctx.check();
    await session.inspectProperties(npc.serial).catch(() => {});
    const title = session.world.entities.get(npc.serial)?.properties?.[0]?.arguments ?? '';
    seen.push(title.replace(/\t/g, ' ').trim());
    if (!ESCORTS.test(title)) continue;
    // Both entries work within three tiles (greyed out farther away): offered at all means the
    // NPC is free; walk up, then read the menu again for usable entries.
    const offered = await session.context(npc.serial).catch(() => []);
    if (!offered.some((e) => e.cliloc === ACCEPT) || !npc.position) continue;
    skip.set(npc.serial, Date.now() + 30 * 60_000);
    // Escorts wander: follow up to three times, reading the menu once next to them.
    let ask: { cliloc: number; index: number; flags: number } | undefined;
    let accept: typeof ask;
    for (let tries = 0; tries < 3 && !(ask && accept); tries++) {
      await ctx.navigate(session.world.entities.get(npc.serial)?.position ?? npc.position, 1).catch(() => {});
      await Bun.sleep(400);
      const menu = await session.context(npc.serial).catch(() => []);
      ask = menu.find((e) => e.cliloc === ASK && !(e.flags & 1));
      accept = menu.find((e) => e.cliloc === ACCEPT && !(e.flags & 1));
    }
    if (!ask || !accept) {
      log(`Could not reach ${npc.name ?? 'the escort'} to talk about the journey`);
      continue;
    }
    const heard = new Set(session.world.journal);
    session.selectContext(npc.serial, ask.index);
    await session.waitFor(() => !!destinationOf(ctx, npc.serial, heard), 'escort destination', 4000).catch(() => {});
    const said = destinationOf(ctx, npc.serial, heard);
    const town = said && towns[said];
    const bank = town && pickLocation(town, 'banker');
    if (!bank) {
      log(`Not escorting ${npc.name ?? 'an escort'} to ${said ?? 'an unknown place'}: no safe gate-to-gate trip`);
      continue;
    }
    const from = nearestGate(here);
    const to: Gate = nearestGate(bank);
    if (distance(here, moongates[from]) > GATE_WALK || distance(bank, moongates[to]) > GATE_WALK) {
      log(`Not escorting ${npc.name ?? 'an escort'} to ${said}: too far from a moongate`);
      continue;
    }
    const before = ctx.count(gold);
    const accepted = new Set(session.world.journal);
    session.selectContext(npc.serial, accept.index);
    await session
      .waitFor(
        () =>
          session.world.journal.some(
            (e) => !accepted.has(e) && e.serial === npc.serial && /lead on/i.test(e.text ?? '')
          ),
        'escort accepted',
        4000
      )
      .catch(() => {});
    if (
      !session.world.journal.some((e) => !accepted.has(e) && e.serial === npc.serial && /lead on/i.test(e.text ?? ''))
    ) {
      log(`${npc.name ?? 'The escort'} did not accept me (resting between escorts, or taken)`);
      return false;
    }
    phase('escorting', `Escorting ${npc.name ?? 'a traveller'} to ${said} for pay`);
    try {
      await lead(ctx, npc.serial, from, to, bank);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      log(`Escort to ${said} failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    const paid = () =>
      ctx.count(gold) > before ||
      session.world.journal.some((e) => !accepted.has(e) && e.serial === npc.serial && e.cliloc === ARRIVED);
    await session.waitFor(paid, 'escort payment', 15_000).catch(() => {});
    if (!paid()) {
      log(`Reached ${said} but ${npc.name ?? 'the escort'} did not pay`);
      return false;
    }
    tally(session, 'goldFromEscorts', ctx.count(gold) - before);
    phase('escort-paid', `Escorted ${npc.name ?? 'a traveller'} to ${said}; paid ${ctx.count(gold) - before} gold`);
    return true;
  }
  log(`No escort in view; saw ${seen.slice(0, 6).join(' | ') || 'nobody'}`);
  return false;
}

// Walks a few tiles at a time so the follower stays close (it is lost after two minutes out of sight), waits
// for it at the moongate so it comes through, and stops at the destination's bank.
async function lead(ctx: Ctx, escort: number, from: Gate, to: Gate, bank: { x: number; y: number }) {
  const { session } = ctx;
  const follower = () => session.world.entities.get(escort)?.position;
  const waitFor = async (range: number) => {
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      ctx.check();
      const at = follower();
      if (at && distance(ctx.position(), at) <= range) return;
      await Bun.sleep(1000);
    }
    throw new Error('the escort fell behind');
  };
  const walk = async (goal: { x: number; y: number }, range: number) => {
    while (distance(ctx.position(), goal) > range) {
      // A few tiles at a time, then wait: the escort stays at the resident's side all the way.
      await ctx.navigate(goal, Math.max(range, distance(ctx.position(), goal) - 4));
      await waitFor(2);
    }
  };
  if (from !== to) {
    await walk(moongates[from], 3);
    await waitFor(2);
    await travelByMoongate(ctx, to);
    await waitFor(3);
  }
  await walk(bank, 4);
}
