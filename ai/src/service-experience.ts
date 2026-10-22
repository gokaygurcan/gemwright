import { randomUUID } from 'node:crypto';

import { type ExperienceEvent, rememberExperience, serviceAdvice } from './experience';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position } from './protocol/world';
import type { Checkpoint } from './store';

type Outcome = Extract<ExperienceEvent, { kind: 'service' }>['outcome'];
export function createServiceExperience(ctx: {
  checkpoint: Checkpoint;
  session: PlayerSession;
  position: () => Position;
  persist: () => void;
}) {
  const advice = (mobile: Entity, action: number, needs: readonly number[] = []) =>
    serviceAdvice(
      ctx.checkpoint,
      { map: ctx.session.world.map ?? 1, ...(mobile.position ?? ctx.position()) },
      mobile.serial,
      action,
      Date.now(),
      needs
    );
  const record = (mobile: Entity, action: number, outcome: Outcome, needs: readonly number[] = []) => {
    const observed = ctx.session.world.entities.get(mobile.serial);
    if (ctx.session.phase !== 'ready' || !observed?.position || observed.kind !== 'mobile') return;
    rememberExperience(ctx.checkpoint, {
      kind: 'service',
      id: randomUUID(),
      at: Date.now(),
      map: ctx.session.world.map ?? 1,
      ...observed.position,
      vendor: mobile.serial,
      action,
      outcome,
      needs: [...new Set(needs)].sort((a, b) => a - b).slice(0, 16)
    });
    ctx.persist();
  };
  const order = (mobiles: Entity[], action: number, needs: readonly number[] = []) =>
    // BaseVendor.IsInvulnerable is visible as notoriety 7 on the verified ServUO profile.
    // Player characters cannot offer NPC bank/buy/sell services.
    mobiles
      .filter((mobile) => mobile.kind === 'mobile' && mobile.notoriety === 7)
      .sort((a, b) => {
        const score = (mobile: Entity) =>
          distance(ctx.position(), mobile.position ?? ctx.position()) -
          (advice(mobile, action, needs).successful ? 6 : 0) +
          (advice(mobile, action, needs).cooldownUntil ? 1000 : 0);
        return score(a) - score(b);
      });
  return {
    record,
    order,
    blocked: (mobile: Entity, action: number, needs: readonly number[] = []) =>
      advice(mobile, action, needs).cooldownUntil > Date.now()
  };
}
