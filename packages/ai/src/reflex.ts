import { InteractionInterrupt } from './action-errors';
import { Blocked } from './blocked';
import { returnToNearestTown } from './cemeteries';
import { executionFor } from './execution-session';
import type { FighterContext } from './fighter-context';
import { distance } from './navigation';
import { perceptionFor } from './perception-session';
import { recordSelf } from './recording';
import { encounterTarget, retaliationAssessment, type SelfState, selfState } from './self-state';

// The combat tick: twice a second the fighter looks at itself (self-state.ts) and, when something
// it can beat is hitting it, fights back now, whatever it was doing: walking, retreating, waiting
// out danger. It takes the best weapon from its pack first when its hands are empty. Everything
// else yields while it fights (yieldForInteraction) and carries on afterwards.
const TICK_MS = 500;

const snapshot = (self: SelfState) => ({
  hits: self.hits,
  maxHits: self.maxHits,
  dead: self.dead,
  held: self.held && { serial: self.held.serial, graphic: self.held.graphic, layer: self.held.layer },
  spare: self.spare && { serial: self.spare.serial, graphic: self.spare.graphic },
  attackers: self.attackers.map((m) => ({ serial: m.serial, graphic: m.graphic, name: m.name }))
});

export function startReflex(ctx: FighterContext, onKill: (serial: number) => void = () => {}): () => void {
  const { session } = ctx;
  let busy = false;
  let last = '';
  let assessedAt = 0;
  const timer = setInterval(() => {
    if (busy || session.phase !== 'ready') return;
    const self = selfState(session, ctx.dead());
    const seen = JSON.stringify(snapshot(self));
    if (seen !== last) {
      last = seen;
      recordSelf(session, snapshot(self));
    }
    // Hurt by nothing in view (poison, an archer out of sight): a scratch is no reason to leave, a
    // wound that starts to tell is.
    const unseenHarm =
      !self.attackers.length && perceptionFor(session).damagedRecently() && self.hits < self.maxHits * 0.5;
    if (self.dead || (!self.attackers.length && !unseenHarm)) return;
    if (Date.now() - assessedAt >= 15_000) {
      assessedAt = Date.now();
      for (const mobile of self.attackers)
        ctx.log(`Retaliation assessment: ${JSON.stringify(retaliationAssessment(session, self, mobile))}`);
    }
    const arbiter = executionFor(session).arbiter;
    if (arbiter.activeKind('reflex') || arbiter.activeKind('escape')) return;
    // Already trading blows with one of them in its own fight: that fight goes on.
    if (arbiter.activeKind('combat') && self.attackers.some((m) => m.serial === session.world.combatant)) return;
    // The whole encounter judged at once, the quickest kill first (self-state.ts).
    const target = encounterTarget(session, self);
    busy = true;
    // Fight or flight, never neither: with nothing here it can beat (the rest counted), it leaves
    // now, as an escape no further hit can cancel. Standing still among them is how it died.
    if (!target) {
      ctx.phase(
        'fleeing',
        self.attackers.length
          ? `Nothing here I can beat: ${self.attackers.map((m) => m.name ?? 'something').join(', ')}`
          : `Hurt by something unseen (${self.hits}/${self.maxHits}); leaving`
      );
      void returnToNearestTown(ctx)
        .catch((error) => {
          if (session.phase === 'ready') ctx.log(`Flight stopped: ${error instanceof Error ? error.message : error}`);
        })
        .finally(() => {
          busy = false;
        });
      return;
    }
    void fightBack(ctx, target.serial, onKill)
      .catch((error) => {
        if (session.phase === 'ready')
          ctx.log(`Fighting back stopped: ${error instanceof Error ? error.message : error}`);
      })
      .finally(() => {
        busy = false;
      });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function fightBack(ctx: FighterContext, serial: number, onKill: (serial: number) => void) {
  const { session } = ctx;
  const arbiter = executionFor(session).arbiter;
  // Walking, retreating or waiting out danger stops here; each picks up again once the fight is over.
  arbiter.interruptBelow('reflex', new InteractionInterrupt());
  // What it interrupted lets go of war mode and the hands first, or taking them fails as busy.
  await arbiter.preempted('reflex');
  await arbiter.run(
    'reflex',
    `Fighting back against ${session.world.entities.get(serial)?.name ?? 'an attacker'}`,
    async () => {
      const name = () => session.world.entities.get(serial)?.name ?? 'an attacker';
      ctx.phase(
        'fighting-back',
        `Fighting back: ${JSON.stringify(retaliationAssessment(session, selfState(session, ctx.dead()), session.world.entities.get(serial) ?? { serial, kind: 'mobile', graphic: 0 }))}`
      );
      const first = selfState(session, ctx.dead());
      if (!first.held && first.spare) {
        const layer = ctx.terrain.tile(first.spare.graphic, true).layer;
        await session.equipItem(first.spare.serial, layer).catch((error) => {
          if (session.phase !== 'ready') throw error;
          ctx.log(`Could not take up item ${first.spare?.serial}: ${error instanceof Error ? error.message : error}`);
        });
      }
      session.setWarMode(true);
      while (!session.world.deaths.has(serial)) {
        const target = session.world.entities.get(serial);
        const self = selfState(session, ctx.dead());
        if (self.dead || !target?.position || distance(ctx.position(), target.position) > 12) break;
        // Stop when the encounter is no longer one it wins (more joined, health ran low): the next
        // tick flees.
        if (!encounterTarget(session, self)) break;
        if (session.world.combatant !== serial) await session.attack(serial);
        if (distance(ctx.position(), target.position) > 1)
          await ctx.navigate(target.position, 1).catch((error) => {
            if (!(error instanceof Blocked)) throw error;
          });
        await Bun.sleep(400);
      }
      if (session.world.deaths.has(serial)) {
        onKill(serial);
        ctx.log(`Fought back and killed ${name()}; corpse collection queued`);
      }
    },
    60_000,
    true
  );
}
