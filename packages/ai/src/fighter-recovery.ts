import { nearAnyGround, returnHome, travelNear } from './cemeteries';
import { type DecisionCoordinator, type DecisionPick, decisionGuard, decisionState } from './decisions';
import { dungeonWalker, inAnyDungeon } from './dungeon-tools';
import { rememberExperience } from './experience';
import { Died, type FighterContext, observedThreat } from './fighter-context';
import { distance } from './navigation';
import { gumpCommands } from './protocol/gumps';
import { resurrectGhost } from './resurrection';

export function resurrectionButton(layout: string): number | undefined {
  const commands = gumpCommands(layout);
  const labels = commands.filter((command) => command[0]?.startsWith('xmfhtmlgump'));
  if (
    !labels.some((command) => command[5] === '1011022') ||
    !labels.some((command) => ['1011023', '1011024', '1011025', '1011026'].includes(command[5] ?? '')) ||
    !labels.some((command) => command[5] === '1011011')
  )
    return;
  // The recognized ordinary healer offer has a free Continue reply; paid offers use another layout.
  if (commands.some((command) => command[0] === 'button' && command[5] === '1' && command[7] === '1')) return 1;
}

export function corpseRecoveryChoice(input: {
  policy: FighterContext['template']['behavior']['corpseRecovery'];
  ageMs: number;
  attempts: number;
  healthRatio: number;
  threats: number;
}): 'recover' | 'replace' | 'seek-help' {
  if (input.policy === 'seek-help') return 'seek-help';
  if (
    input.policy === 'replace-equipment' ||
    !Number.isFinite(input.ageMs) ||
    input.ageMs > 15 * 60_000 ||
    input.attempts >= 2 ||
    input.healthRatio < 0.8 ||
    input.threats > 0
  )
    return 'replace';
  return 'recover';
}

export function createFighterRecovery(
  ctx: FighterContext,
  services: {
    rest: () => Promise<void>;
    equip: () => Promise<void>;
    prepareEquipment: () => Promise<void>;
    decisions?: DecisionCoordinator;
  }
) {
  const {
    session,
    template,
    serial,
    position,
    check,
    phase,
    navigate,
    escapeNavigate,
    trip,
    persist,
    nearby,
    open,
    contents,
    dead,
    state,
    stats,
    status
  } = ctx;
  const threats = () =>
    nearby().filter(
      (mobile) =>
        mobile.position && observedThreat(mobile, session.world.combatant) && distance(position(), mobile.position) < 8
    );
  const identifyPersonalCorpse = async () => {
    const name = trip.recovery?.ownerName || session.world.entities.get(serial)?.name;
    const site = trip.deathSite;
    if (!name) return;
    for (const body of [...session.world.entities.values()]) {
      if (
        body.graphic !== 0x2006 ||
        !body.position ||
        distance(position(), body.position) > 18 ||
        (site && distance(site, body.position) > 18)
      )
        continue;
      try {
        await session.inspectProperties(body.serial);
      } catch {
        check();
        continue;
      }
      if (
        session.world.entities
          .get(body.serial)
          ?.properties?.some((property) => property.cliloc === 1046414 && property.arguments === name)
      ) {
        trip.corpse = { serial: body.serial, ...body.position };
        persist();
        return;
      }
    }
  };
  const abandon = (reason: string) => {
    if (!trip.recovery) throw new Error('Missing recovery state');
    trip.recovery.stage = 'equipment';
    trip.recovery.outcome = reason;
    delete trip.corpse;
    delete trip.deathSite;
    stats.abandonedCorpses++;
    rememberExperience(ctx.checkpoint, {
      kind: 'recovery',
      id: `corpse:${trip.recovery.diedAt}`,
      at: Date.now(),
      map: session.world.map ?? 1,
      ...position(),
      outcome: 'abandoned'
    });
    phase('abandoning-corpse', reason);
  };
  const captureDeath = () => {
    const lastSeen = trip.encounter?.position;
    const encounter = trip.encounter;
    if (encounter?.memoryId && encounter.body !== undefined) {
      const changes = session.world.healthChanges.filter((change) => change.at >= Date.parse(encounter.startedAt));
      rememberExperience(ctx.checkpoint, {
        kind: 'combat',
        id: encounter.memoryId,
        at: Date.now(),
        map: session.world.map ?? 1,
        ...(lastSeen ?? position()),
        body: encounter.body,
        outcome: 'death',
        lowestHealthRatio: 0,
        largestLossRatio: Math.max(0, ...changes.map((change) => change.damage / Math.max(1, change.maxHits))),
        damageRatio: changes.reduce((sum, change) => sum + change.damage / Math.max(1, change.maxHits), 0)
      });
    }
    const deathTime = session.world.deathSite
      ? new Date().toISOString()
      : (trip.encounter?.startedAt ?? new Date(0).toISOString());
    if (trip.recovery?.stage !== 'healer') {
      trip.recovery = {
        stage: 'healer',
        diedAt: deathTime,
        ownerName: session.world.entities.get(serial)?.name ?? '',
        attempts: 0
      };
      delete trip.corpse;
      delete trip.deathSite;
    }
    trip.pending = 'return';
    delete trip.encounter;
    const death = session.world.deaths.get(serial);
    if (death?.position) trip.corpse = { serial: death.corpse, ...death.position };
    if (session.world.deathSite) {
      trip.deathSite = { ...session.world.deathSite };
      trip.recovery.locationSource = 'death-status';
    } else if (!trip.deathSite && lastSeen) {
      trip.deathSite = { ...lastSeen };
      trip.recovery.locationSource = 'last-seen';
    }
    phase('death-recorded', 'Preserving the recovery goal and observed death location');
  };
  const resurrect = async () => {
    state.recovering = true;
    state.inCombat = false;
    captureDeath();
    try {
      await identifyPersonalCorpse();
      session.setWarMode(false);
      // The closest healer or ankh, anywhere on the map (moongate when far).
      if (dead()) await resurrectGhost(ctx);
      stats.resurrections++;
      if (!trip.recovery) throw new Error('Missing persisted death recovery');
      trip.recovery.stage = 'corpse';
      phase('resurrected', 'Server confirmed a living body; retaining the corpse recovery goal');
    } finally {
      state.recovering = false;
    }
    await ctx.refreshBackpack();
    await session.refreshStatus();
  };
  const recoverCorpse = async () => {
    const recovery = trip.recovery;
    if (!recovery) return;
    const choice = () =>
      corpseRecoveryChoice({
        policy: template.behavior.corpseRecovery,
        ageMs: Date.now() - Date.parse(recovery.diedAt),
        attempts: recovery.attempts,
        healthRatio: status().hits / Math.max(1, status().maxHits),
        threats: threats().length
      });
    let selected = choice();
    let corpsePick: DecisionPick | null = null;
    // Recovery is a judgement call: the corpse holds gear, but returning to a death site is risky.
    // Hard limits (threats, attempts, policy, decay) stay local; the provider weighs the rest with
    // the local rule as baseline.
    const ageMs = Date.now() - Date.parse(recovery.diedAt);
    const recoverable = () =>
      template.behavior.corpseRecovery !== 'replace-equipment' &&
      threats().length === 0 &&
      recovery.attempts < 2 &&
      Number.isFinite(ageMs) &&
      ageMs < 15 * 60_000 &&
      status().hits >= status().maxHits * 0.6;
    if (services.decisions && recoverable()) {
      const pick = await services.decisions.choose({
        kind: 'corpse-recovery',
        checkpoint: ctx.checkpoint,
        state: decisionState(session, template, ctx.checkpoint, {
          profession: 'fighter',
          corpseAgeMinutes: Math.round(ageMs / 60_000),
          attempts: recovery.attempts,
          corpseItems: 'equipment and loot carried at death',
          note: 'Player corpses decay; the killer may still be near the death site.'
        }),
        observationRevision: session.world.revision,
        baseline: selected === 'recover' ? 'recover' : 'replace',
        stillCurrent: decisionGuard(session),
        candidates: [
          {
            id: 'recover',
            description: 'Return carefully to the death site and take back the corpse contents.',
            valid: recoverable
          },
          {
            id: 'replace',
            description: 'Abandon the corpse; use banked gear and buy essentials in town.',
            valid: () => true
          }
        ]
      });
      check();
      if (pick) {
        selected = pick.id === 'recover' ? 'recover' : 'replace';
        corpsePick = pick;
        if (pick.id !== 'recover') services.decisions.finish(ctx.checkpoint, pick, 'completed', 'Abandoned the corpse');
      }
    }
    if (selected !== 'recover') {
      if (selected === 'seek-help') session.say('I lost my belongings. Could someone help me recover them?');
      abandon(
        selected === 'seek-help'
          ? 'Requested help; replacing essentials without assuming a reply.'
          : 'Corpse recovery is outside the current health, age, threat, attempt, or template limits.'
      );
      return;
    }
    if (!trip.corpse && !trip.deathSite) {
      abandon('No player-observed corpse location survived; replacing essentials.');
      return;
    }
    recovery.attempts++;
    phase('recovering-corpse', 'Approaching the recorded death site cautiously and checking observed threats');
    state.recoveringCorpse = true;
    try {
      const site = trip.corpse ?? trip.deathSite;
      if (!site) throw new Error('Death location disappeared');
      // A corpse in a dungeon is reached over its stairways (dungeon-tools.ts).
      if (inAnyDungeon(site)) await dungeonWalker(ctx, () => false).travelTo(site, 8);
      else await travelNear(ctx, site, 8);
      if (threats().length) throw new Error('Observed threats make the corpse approach unsafe');
      // Re-identify ownership even when a serial was retained across reconnects.
      delete trip.corpse;
      await identifyPersonalCorpse();
      const corpse = trip.corpse as { serial: number; x: number; y: number; z: number } | undefined;
      if (!corpse) throw new Error('Personal corpse is no longer observed at the death site');
      await navigate(corpse, 1);
      await open(corpse.serial);
      for (const item of contents(corpse.serial)) {
        check();
        if (status().weight >= status().maxWeight * 0.9 || contents().length >= 110)
          throw new Error('Cannot safely carry the remaining corpse contents');
        await session.moveItem(item.serial, ctx.backpack());
        stats.recoveredItems++;
        persist();
        await Bun.sleep(700);
        await session.refreshStatus();
      }
      recovery.stage = 'equipment';
      recovery.outcome = 'Recovered all observed personal corpse contents.';
      rememberExperience(ctx.checkpoint, {
        kind: 'recovery',
        id: `corpse:${recovery.diedAt}`,
        at: Date.now(),
        map: session.world.map ?? 1,
        ...position(),
        outcome: 'recovered'
      });
      delete trip.corpse;
      delete trip.deathSite;
      phase('corpse-recovered', recovery.outcome);
      services.decisions?.finish(ctx.checkpoint, corpsePick, 'completed', recovery.outcome);
    } catch (error) {
      if (dead() || session.phase !== 'ready' || Date.now() >= ctx.deadline) throw error;
      state.recoveringCorpse = false;
      check();
      services.decisions?.finish(
        ctx.checkpoint,
        corpsePick,
        'failed',
        error instanceof Error ? error.message : 'failed'
      );
      abandon(error instanceof Error ? error.message : 'Corpse recovery could not be confirmed');
    } finally {
      state.recoveringCorpse = false;
    }
    const below = inAnyDungeon(position());
    if (below) await dungeonWalker(ctx, () => false).climbOut(below);
    // Home may be across water from a far healer (Skara Brae): through the moongate first.
    await returnHome(ctx);
    await escapeNavigate(ctx.home.town, 4);
  };
  const resume = async () => {
    if (dead()) await resurrect();
    if (!trip.recovery && (trip.corpse || trip.deathSite)) {
      trip.recovery = {
        stage: 'corpse',
        diedAt: new Date(0).toISOString(),
        ownerName: session.world.entities.get(serial)?.name ?? '',
        attempts: 0
      };
      persist();
    }
    if (!trip.recovery || trip.recovery.stage === 'ready') return;
    if (trip.recovery.stage === 'healer') {
      // A reconnect may observe resurrection after its acknowledgement was lost.
      trip.recovery.stage = 'corpse';
      persist();
    }
    await ctx.refreshBackpack();
    if (trip.recovery.stage === 'corpse') {
      await returnHome(ctx);
      await escapeNavigate(ctx.home.town, 4);
      await services.rest();
      await recoverCorpse();
    }
    if (trip.recovery.stage === 'equipment') {
      if (threats().length || nearAnyGround(position())) {
        await returnHome(ctx);
        await escapeNavigate(ctx.home.town, 4);
      }
      await services.prepareEquipment();
      await services.equip();
      await services.rest();
      trip.recovery.stage = 'ready';
      trip.pending = 'return';
      phase('recovery-ready', 'Living, equipped and recovered; reconciling the town trip before hunting again');
    }
  };
  const recover = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await resume();
        return;
      } catch (error) {
        if (session.phase !== 'ready' || Date.now() >= ctx.deadline) throw error;
        if (!(error instanceof Died) && !dead()) throw error;
      }
    }
    throw new Error('Repeated deaths during recovery; preserving the recovery goal for a later run');
  };
  return { recover };
}
