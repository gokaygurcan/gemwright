import { skillId } from '@gemwright/common/skills';

import { createNavigator } from './navigation';
import type { ProfessionContext } from './profession';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity, JournalEntry } from './protocol/world';
import { servuoRules } from './shard-profile';
import { refuse } from './thief-marks';

// Snooping, Stealing, Hiding and Stealth as the pinned ServUO revision implements them
// (Scripts/Skills/Stealing.cs, Snooping.cs, Hiding.cs, Stealth.cs), with every server interaction
// observed and bounded. An unanswered action is never replayed.
//
// Stealing: both hands free, adjacent to the item, ten stones at most, a skill check against ten
// times the weight with a 22.5/27.5 window either side, and a random item when a mobile is
// targeted. A caught theft is criminal only when the owner is innocent, which monsters are not.
// Snooping is not a skill use at all: double-clicking a container whose root is another mobile runs
// the check, and creature backpacks refuse players outright.
export interface ThiefSkillState {
  hidden: boolean;
  sneaking: boolean;
  sneakSteps: number;
  nextSkillAt: number;
  hideRetryAt: number;
  sneakRetryAt: number;
}

export type StealOutcome = 'stolen' | 'failed' | 'heavy' | 'empty' | 'far' | 'refused' | 'full' | 'hands' | 'wait';

// Every skill shares one NextSkillTime (Server/Skills.cs UseSkill), and Hiding, Stealth and
// Stealing all answer with ten seconds, so the thief spends at most one use per window.
const SKILL_WINDOW_MS = 10_500;
const SKILL_RETRY_MS = 4_000;

// Replies on the pinned revision. Stealing.cs: 502723 failure, 502724 success, 1005584 empty
// hands, 502703 too far, 1005585 equipped, 1005596 thieves guild, 1005598 shopkeeper, 502710
// cannot steal that, 502704 red-handed, 500237 unseen, 1048147 pack full, "too heavy" as text.
// Hiding.cs: 501238 busy, 501240 hidden, 501237/501241 cannot hide. Stealth.cs: 502725 hide first,
// 502726 not hidden well enough, 502727 too much armor, 1063086 cannot right now, 502730 moves quietly, 502731 failed.
// Snooping.cs: 500210 failed peek, 1001018 negative acts, 500209 cannot peek, 500446 too far.
const STEAL_SUCCESS = 502724;
const STEAL_FAILED = 502723;
const HANDS_FREE = 1005584;
const STEAL_TOO_FAR = 502703;
const STEAL_UNSEEN = 500237;
const STEAL_REFUSED = [1005585, 1005596, 1005598, 502710, 502704, 500237];
const STEAL_PACK_FULL = 1048147;
const SKILL_TOO_SOON = 500118;
const HIDE_OK = 501240;
const HIDE_BUSY = 501238;
const HIDE_REFUSED = [501237, 501241];
const SNEAK_OK = 502730;
const NOT_HIDDEN_WELL = 502726;
const SNEAK_REFUSED = [502725, NOT_HIDDEN_WELL, 502727, 1063086, 502731];
const SNOOP_FAILED = 500210;
const SNOOP_REFUSED = [1001018, 500209, 500446];
const TOO_HEAVY = 'That is too heavy to steal.';

export function createThiefSkills(state: ThiefSkillState) {
  let cache: { session: PlayerSession; navigate: ReturnType<typeof createNavigator> } | null = null;

  const snapshot = (session: PlayerSession) => new Set(session.world.journal);
  const replySince = (session: PlayerSession, seen: Set<JournalEntry>, clilocs: number[]) =>
    session.world.journal.find(
      (entry) => !seen.has(entry) && entry.cliloc !== undefined && clilocs.includes(entry.cliloc)
    );
  const textSince = (session: PlayerSession, seen: Set<JournalEntry>, text: string) =>
    session.world.journal.find((entry) => !seen.has(entry) && entry.text?.trim() === text);

  // A timeout is an outcome of its own: the turn moves on with what was observed.
  async function waitReply(
    session: PlayerSession,
    seen: Set<JournalEntry>,
    clilocs: number[],
    label: string,
    ms: number
  ) {
    try {
      await session.waitFor(() => !!replySince(session, seen, clilocs), label, ms);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
    }
    return replySince(session, seen, clilocs);
  }

  async function useSkill(ctx: ProfessionContext, skill: string, clilocs: number[], label: string, ms = 3000) {
    const { session } = ctx;
    const seen = snapshot(session);
    session.useSkill(skillId(skill));
    state.nextSkillAt = Date.now() + SKILL_WINDOW_MS;
    const reply = await waitReply(session, seen, clilocs, label, ms);
    if (reply?.cliloc === SKILL_TOO_SOON) state.nextSkillAt = Date.now() + SKILL_RETRY_MS;
    return reply;
  }

  const windowOpen = () => Date.now() >= state.nextSkillAt;
  async function waitForWindow(ctx: ProfessionContext) {
    while (!windowOpen()) {
      ctx.check();
      await Bun.sleep(Math.min(500, Math.max(0, state.nextSkillAt - Date.now())));
    }
  }

  // A run in the dark keeps the walking pace; running or exhausting the stealth budget reveals the
  // thief (Server/Mobile.cs OnMove).
  const sneakNavigator = (ctx: ProfessionContext) => {
    if (cache?.session !== ctx.session)
      cache = {
        session: ctx.session,
        navigate: createNavigator({
          session: ctx.session,
          terrain: ctx.terrain,
          check: ctx.check,
          phase: ctx.phase,
          log: ctx.log,
          walkOnly: () => state.hidden && state.sneaking,
          onStep: () => {
            if (state.sneakSteps > 0) state.sneakSteps--;
            if (state.sneakSteps === 0) {
              state.sneaking = false;
              state.hidden = false;
            }
          }
        })
      };
    return cache.navigate;
  };

  // Both hands must be free to steal (Stealing.cs IsEmptyHanded). The thief holds no tools, so any
  // equipped item is put away before the attempt.
  async function freeHands(ctx: ProfessionContext): Promise<boolean> {
    const hands = ctx.session.world
      .childrenOf(ctx.serial)
      .filter((item) => item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded);
    for (const item of hands) {
      ctx.check();
      await ctx.session.moveItem(item.serial, ctx.backpack());
    }
    if (hands.length) ctx.log(`Put away ${hands.length} held item(s); both hands must be free to steal`);
    return hands.length > 0;
  }

  // Hiding skill when Stealth last answered "not hidden well enough" (Stealth.HidingRequirement);
  // the thief walks in openly until Hiding has risen past it.
  let hidingAtRefusal: number | undefined;
  const tooUnskilledToSneak = (ctx: ProfessionContext) => {
    const hiding = ctx.session.world.skills.get(skillId('Hiding'))?.base ?? 0;
    return (
      hiding < servuoRules().stealthHidingRequirement || (hidingAtRefusal !== undefined && hiding <= hidingAtRefusal)
    );
  };

  async function hide(ctx: ProfessionContext): Promise<boolean> {
    const reply = await useSkill(ctx, 'Hiding', [HIDE_OK, HIDE_BUSY, ...HIDE_REFUSED], 'hiding result');
    state.hidden = reply?.cliloc === HIDE_OK;
    if (!state.hidden) state.hideRetryAt = Date.now() + 60_000;
    ctx.log(state.hidden ? 'Hidden from sight' : `Could not hide (reply ${reply?.cliloc ?? 'none'})`);
    return state.hidden;
  }

  async function sneak(ctx: ProfessionContext): Promise<boolean> {
    const reply = await useSkill(ctx, 'Stealth', [SNEAK_OK, ...SNEAK_REFUSED], 'stealth result');
    state.sneaking = reply?.cliloc === SNEAK_OK;
    if (reply?.cliloc === NOT_HIDDEN_WELL) hidingAtRefusal = ctx.session.world.skills.get(skillId('Hiding'))?.base ?? 0;
    if (!state.sneaking) state.sneakRetryAt = Date.now() + 60_000;
    state.hidden = state.sneaking;
    state.sneakSteps = state.sneaking
      ? Math.max(
          1,
          Math.floor((ctx.session.world.skills.get(skillId('Stealth'))?.base ?? 0) / servuoRules().stealthPointsPerStep)
        )
      : 0;
    ctx.log(state.sneaking ? `Moving quietly for ${state.sneakSteps} step(s)` : 'Sneaking failed');
    return state.sneaking;
  }

  // Stealing targets a mobile: the server takes a random item from its pack, refuses with one of
  // the listed replies, or says nothing at all when the pack holds nothing to take (Stealing.cs
  // OnTarget skips empty packs).
  async function steal(ctx: ProfessionContext, mark: Entity): Promise<StealOutcome> {
    const { session } = ctx;
    if (session.world.target) session.target(null);
    const seen = snapshot(session);
    session.useSkill(skillId('Stealing'));
    state.nextSkillAt = Date.now() + SKILL_WINDOW_MS;
    const refusal = await Promise.race([
      waitReply(session, seen, [HANDS_FREE, SKILL_TOO_SOON], 'stealing refused', 3000),
      session
        .waitFor(() => session.world.target !== null, 'stealing cursor', 3000)
        .then(
          () => undefined,
          () => undefined
        )
    ]);
    if (refusal?.cliloc === HANDS_FREE) return 'hands';
    if (refusal?.cliloc === SKILL_TOO_SOON) {
      state.nextSkillAt = Date.now() + SKILL_RETRY_MS;
      return 'wait';
    }
    if (session.world.target === null) return 'wait';
    const before = new Set(session.world.childrenOf(ctx.backpack()).map((item) => item.serial));
    session.target({ serial: mark.serial, x: 0, y: 0, z: 0, graphic: mark.graphic });
    state.hidden = false;
    state.sneaking = false;
    const after = snapshot(session);
    const results = [STEAL_SUCCESS, STEAL_FAILED, STEAL_TOO_FAR, STEAL_PACK_FULL, SKILL_TOO_SOON, ...STEAL_REFUSED];
    try {
      await session.waitFor(
        () => !!replySince(session, after, results) || !!textSince(session, after, TOO_HEAVY),
        'stealing result',
        5000
      );
    } catch (error) {
      if (session.phase !== 'ready') throw error;
    }
    if (textSince(session, after, TOO_HEAVY)) return 'heavy';
    const reply = replySince(session, after, results);
    if (!reply) return 'empty';
    switch (reply.cliloc) {
      case STEAL_SUCCESS:
        await tidy(ctx, before);
        return 'stolen';
      case STEAL_FAILED:
        return 'failed';
      case STEAL_TOO_FAR:
      case STEAL_UNSEEN:
        return 'far';
      case STEAL_PACK_FULL:
        return 'full';
      case SKILL_TOO_SOON:
        state.nextSkillAt = Date.now() + SKILL_RETRY_MS;
        return 'wait';
      default:
        return 'refused';
    }
  }

  // A successful theft lands in the backpack a moment later; graveyard refuse is dropped where the
  // thief stands instead of being carried home.
  async function tidy(ctx: ProfessionContext, before: Set<number>) {
    await Bun.sleep(400);
    const fresh = ctx.session.world.childrenOf(ctx.backpack()).filter((item) => !before.has(item.serial));
    for (const item of fresh) {
      if (!refuse.has(item.graphic)) continue;
      ctx.check();
      await ctx.session.dropAtFeet(item.serial);
    }
  }

  // Double-clicking someone else's pack runs the snooping check (Container.OnSnoop →
  // Snooping.cs Container_Snoop). Success opens the container so its contents become observations.
  async function snoop(ctx: ProfessionContext, owner: Entity, pack: Entity): Promise<boolean> {
    const { session } = ctx;
    const opened = session.world.received.get(0x3c) ?? 0;
    const displayed = session.world.received.get(0x24) ?? 0;
    const seen = snapshot(session);
    session.use(pack.serial);
    const ready = () =>
      (session.world.received.get(0x3c) ?? 0) > opened ||
      (session.world.received.get(0x24) ?? 0) > displayed ||
      !!replySince(session, seen, [SNOOP_FAILED, ...SNOOP_REFUSED]);
    try {
      await session.waitFor(ready, 'snooping result', 3000);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
    }
    if ((session.world.received.get(0x3c) ?? 0) > opened || (session.world.received.get(0x24) ?? 0) > displayed) {
      const items = session.world.childrenOf(pack.serial);
      ctx.progress.snooped = (ctx.progress.snooped ?? 0) + 1;
      ctx.log(`Peeked into the pack of ${owner.name ?? 'a pack animal'} and saw ${items.length} item(s)`);
      return true;
    }
    const reply = replySince(session, seen, [SNOOP_FAILED, ...SNOOP_REFUSED]);
    ctx.log(
      `No peek into the pack of ${owner.name ?? 'a pack animal'}: ${
        reply?.cliloc === SNOOP_FAILED ? 'failed the snooping check' : `reply ${reply?.cliloc ?? 'none'}`
      }`
    );
    return false;
  }

  return { waitForWindow, sneakNavigator, freeHands, hide, sneak, steal, snoop, tooUnskilledToSneak };
}
