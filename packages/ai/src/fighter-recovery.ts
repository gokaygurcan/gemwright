import { corpse as corpseGraphic, ItemProperty } from '@gemwright/common/game/items';
import { gumpCommands } from '@gemwright/network/gumps';

import { ActionInterrupted, InteractionInterrupt } from './action-errors';
import { checkedDelay } from './action-purpose';
import { travelNear } from './cemeteries';
import { selfLootCorpse } from './corpse-self-loot';
import {
  type DecisionCoordinator,
  type DecisionPick,
  decisionGuard,
  decisionState,
  requireDecision
} from './decisions';
import { dungeonWalker, inAnyDungeon } from './dungeon-tools';
import { actionScope } from './execution-session';
import { rememberExperience } from './experience';
import { rememberDeath } from './fight-confidence';
import { Died, type FighterContext, Retreat } from './fighter-context';
import {
  recoveryEquipmentReady,
  recoveryHealthReady,
  recoveryThreats,
  returnToRefuge,
  weaponObtainable
} from './fighter-refuge';
import { distance } from './navigation';
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
}): 'recover' | 'replace' | 'seek-help' | 'wait' {
  if (input.policy === 'seek-help') return 'seek-help';
  if (input.policy === 'replace-equipment' || !Number.isFinite(input.ageMs) || input.ageMs > 15 * 60_000)
    return 'replace';
  if (input.threats > 0 || input.attempts >= 2) return 'replace';
  if (!Number.isFinite(input.healthRatio) || input.healthRatio < 0.9) return 'wait';
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
  const { session, template, serial, position, check, phase, navigate, trip, persist, dead, state, stats, status } =
    ctx;
  const threats = () => recoveryThreats(ctx);
  const identifyPersonalCorpse = async () => {
    const name = trip.recovery?.ownerName || session.world.entities.get(serial)?.name;
    const site = trip.deathSite;
    if (!name) return;
    for (const body of [...session.world.entities.values()]) {
      if (
        body.graphic !== corpseGraphic ||
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
          ?.properties?.some((property) => property.cliloc === ItemProperty.corpseOf && property.arguments === name)
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
    persist();
  };
  const captureDeath = () => {
    const diedRecovering =
      trip.recovery?.stage === 'equipment' || (trip.recovery?.stage === 'corpse' && trip.recovery.attempts > 0);
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
        capability: encounter.capability,
        creatureName: encounter.creatureName,
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
        attempts: 0,
        abandonCorpse: diedRecovering || undefined
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
    rememberDeath(session);
    phase('death-recorded', 'Preserving the recovery goal and observed death location');
    persist();
  };
  const resurrect = async () => {
    state.recovering = true;
    state.inCombat = false;
    captureDeath();
    try {
      await identifyPersonalCorpse();
      session.setWarMode(false);
      // The closest healer or ankh, anywhere on the map (moongate when far).
      // Fighters weigh their corpse trip themselves (corpseRecoveryChoice), so no automatic one.
      if (dead()) await resurrectGhost(ctx, false);
      if (dead()) throw new Died('Resurrection was not confirmed by a living body');
      stats.resurrections++;
      if (!trip.recovery) throw new Error('Missing persisted death recovery');
      if (trip.recovery.abandonCorpse)
        abandon('Died during corpse recovery; replacing essentials instead of returning.');
      else trip.recovery.stage = 'corpse';
      phase('resurrected', 'Server confirmed a living body; continuing persisted recovery');
      persist();
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
    if (selected === 'recover' && !recoveryHealthReady(ctx)) selected = 'wait';
    if (selected === 'wait') {
      await services.rest();
      return;
    }
    let corpsePick: DecisionPick | null = null;
    // Recovery is a judgement call: the corpse holds gear, but returning to a death site is risky.
    // Hard limits (threats, attempts, policy, decay) stay local; the provider weighs the rest with
    // the local rule as baseline.
    const ageMs = Date.now() - Date.parse(recovery.diedAt);
    const recoverable = () => choice() === 'recover' && recoveryHealthReady(ctx);
    if (services.decisions && recoverable()) {
      const pick = await services.decisions.choose({
        kind: 'corpse-recovery',
        checkpoint: ctx.checkpoint,
        state: decisionState(session, template, ctx.checkpoint, {
          profession: 'fighter',
          corpseAgeMinutes: Math.round(ageMs / 60_000),
          attempts: recovery.attempts,
          corpseItems: 'equipment and loot carried at death',
          note: 'Retrieve only while healthy and unthreatened. Stop on damage or poison; failed retrieval must return to refuge.'
        }),
        observationRevision: session.world.revision,
        baseline: selected === 'recover' ? 'recover' : 'replace',
        stillCurrent: decisionGuard(session),
        candidates: [
          {
            id: 'recover',
            description: 'Safely retrieve observed belongings, then return to refuge before resuming work.',
            valid: recoverable
          },
          {
            id: 'wait',
            description: 'Recover dangerously low health before returning to the corpse; retain its location.',
            valid: () => !recoveryHealthReady(ctx)
          }
        ]
      });
      check();
      const current = requireDecision(pick);
      selected = current.id === 'recover' ? choice() : 'wait';
      if (selected === 'recover' && !recoveryHealthReady(ctx)) selected = 'wait';
      corpsePick = current;
      if (selected === 'wait') {
        await services.rest();
        return;
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
    persist();
    phase('recovering-corpse', 'Approaching the recorded death site cautiously and checking observed threats');
    state.recoveringCorpse = true;
    try {
      await actionScope(
        session,
        'recovery',
        'Recover equipment from my own corpse',
        async () => {
          const site = trip.corpse ?? trip.deathSite;
          if (!site) throw new Error('Death location disappeared');
          // A corpse in a dungeon is reached over its stairways (dungeon-tools.ts).
          if (inAnyDungeon(site)) await dungeonWalker(ctx, () => false).travelTo(site, 8);
          else await travelNear(ctx, site, 8);
          // Re-identify ownership even when a serial was retained across reconnects.
          delete trip.corpse;
          await identifyPersonalCorpse();
          const corpse = trip.corpse as { serial: number; x: number; y: number; z: number } | undefined;
          if (!corpse) {
            abandon('Personal corpse is no longer observed at its recorded location');
            return;
          }
          await navigate(corpse, 1);
          stats.recoveredItems += await selfLootCorpse(ctx, corpse.serial);
          await services.equip();
          await session.refreshStatus();
          recovery.stage = 'equipment';
          recovery.outcome = 'Observed equipment or belongings restored by personal corpse self-loot.';
          delete recovery.retryAt;
          trip.pending = 'return';
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
          persist();
        },
        120_000
      );
    } catch (error) {
      if (dead() || session.phase !== 'ready' || Date.now() >= ctx.deadline) throw error;
      state.recoveringCorpse = false;
      services.decisions?.finish(
        ctx.checkpoint,
        corpsePick,
        'failed',
        error instanceof Error ? error.message : 'failed'
      );
      recovery.retryAt = Date.now() + Math.min(60_000, recovery.attempts * 10_000);
      phase(
        'corpse-recovery-paused',
        `${error instanceof Error ? error.message : 'Corpse recovery unconfirmed'}; retaining the corpse location for another attempt`
      );
      persist();
      if (error instanceof ActionInterrupted || error instanceof InteractionInterrupt) throw error;
      if (error instanceof Retreat || recovery.attempts >= 2)
        abandon(error instanceof Retreat ? error.message : 'Corpse retrieval failed twice; replacing essentials.');
      await returnToRefuge(ctx);
      return;
    } finally {
      state.recoveringCorpse = false;
    }
    await returnToRefuge(ctx);
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
      if (trip.recovery.abandonCorpse)
        abandon('Died during corpse recovery; replacing essentials instead of returning.');
      else trip.recovery.stage = 'corpse';
      persist();
    }
    await ctx.refreshBackpack();
    if (trip.recovery.stage === 'corpse') {
      if ((trip.recovery.retryAt ?? 0) > Date.now()) {
        await checkedDelay(Math.min(1500, (trip.recovery.retryAt ?? 0) - Date.now()), check);
        return;
      }
      await recoverCorpse();
    }
    if (trip.recovery.stage === 'equipment') {
      await returnToRefuge(ctx);
      await services.prepareEquipment();
      await services.equip();
      await services.rest();
      if (
        !recoveryHealthReady(ctx) ||
        threats().length ||
        distance(position(), ctx.home.town) > 4 ||
        (!recoveryEquipmentReady(ctx) && weaponObtainable(ctx))
      ) {
        persist();
        // Not ready again straight after not being ready is a spin, not a recovery: the goal turn
        // calls back at once and rest() returns at once at full health (Drovanis logged
        // "recovering" four times a second). The second pass in a row waits.
        if (Date.now() - notReadyAt < 2000) await checkedDelay(10_000, check);
        notReadyAt = Date.now();
        return;
      }
      trip.recovery.stage = 'ready';
      trip.pending = 'return';
      phase(
        'recovery-ready',
        recoveryEquipmentReady(ctx)
          ? 'Living, equipped and recovered; reconciling the town trip before hunting again'
          : 'Living and recovered, with no weapon to be had; hunting bare-handed to earn one'
      );
      persist();
    }
  };
  let notReadyAt = 0;
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
