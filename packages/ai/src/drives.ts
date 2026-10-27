import { knownBankGold } from './bank-gold';
import { lasting } from './lasting';
import type { LifeContext } from './life';
import { sinceProgress } from './loop-watch';
import { residentNeeds } from './needs';
import type { LifePhase } from './world';

// The goal layer above the trades: what a resident wants right now, scored 0 to 1 from its own
// state, weighted by who it is, and turned into a lean on its next life phase (life.ts). Seven
// drives, as people have: health, money, gear, safety, friends, fun and progress. Two residents in
// the same spot differ through their weights (fixed per resident) and a little chance each pick.
export type Drive = 'health' | 'money' | 'gear' | 'safety' | 'friends' | 'fun' | 'progress';
const DRIVES: Drive[] = ['health', 'money', 'gear', 'safety', 'friends', 'fun', 'progress'];
const HOUR = 3_600_000;

// Which phases answer each drive (positive) and which it avoids (negative).
const answers: Record<Drive, Partial<Record<LifePhase, number>>> = {
  health: { leisure: 0.8, dungeon: -0.8, visit: -0.3 },
  money: { work: 1, errands: 0.3, leisure: -0.4, visit: -0.3 },
  gear: { errands: 1, work: 0.3 },
  safety: { leisure: 0.5, dungeon: -1, visit: -0.4 },
  friends: { leisure: 0.8, visit: 0.6 },
  fun: { leisure: 0.7, visit: 0.7, dungeon: 0.4, work: -0.3 },
  progress: { practice: 0.9, dungeon: 0.4, work: 0.3 }
};

const clamp = (n: number) => Math.max(0, Math.min(1, n));

// Personal weights from the resident's serial: stable across restarts, different between people.
function weightsOf(serial: number): Record<Drive, number> {
  const out = {} as Record<Drive, number>;
  for (const [i, drive] of DRIVES.entries()) {
    let hash = (serial * 2654435761 + i * 40503) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
    out[drive] = 0.6 + (hash % 1000) / 1250; // 0.6 to 1.4
  }
  return out;
}

export function drives(ctx: Pick<LifeContext, 'session' | 'checkpoint' | 'template'>): Record<Drive, number> {
  const { session, checkpoint } = ctx;
  const status = session.world.status;
  const serial = session.world.serial ?? 0;
  const funds = (status?.gold ?? 0) + knownBankGold(checkpoint);
  const lastFriend = Math.max(
    0,
    ...Object.values(checkpoint.relationships).map((r) => Date.parse(r.lastSeen ?? '') || 0)
  );
  // Kept as an expiry a week on (lasting.ts), so the time it was had is a week before that.
  const funUntil = lasting('fun', serial).get('at') ?? 0;
  const lastFun = funUntil ? funUntil - 7 * 24 * HOUR : 0;
  return {
    health: status ? clamp(1 - status.hits / Math.max(1, status.maxHits)) : 0,
    money: clamp(1 - funds / 1000),
    gear: clamp(residentNeeds(session, checkpoint, ctx.template).filter((n) => n.kind !== 'income').length / 3),
    safety: clamp(lasting('deaths', serial).count() / 3),
    friends: clamp((Date.now() - lastFriend) / (3 * HOUR)),
    fun: lastFun ? clamp((Date.now() - lastFun) / (3 * HOUR)) : 0.5,
    progress: clamp(sinceProgress(session) / (2 * HOUR))
  };
}

// The lean on one phase: 1 when nothing presses, up to about 2.5 for what is wanted most, down
// to 0.25 for what is to be avoided, with up to 15% chance either way.
export function driveBias(ctx: Pick<LifeContext, 'session' | 'checkpoint' | 'template'>, phase: LifePhase) {
  const now = drives(ctx);
  const weights = weightsOf(ctx.session.world.serial ?? 0);
  let lean = 0;
  for (const drive of DRIVES) lean += weights[drive] * now[drive] * (answers[drive][phase] ?? 0);
  return Math.max(0.25, (1 + lean) * (0.85 + Math.random() * 0.3));
}

// The drive that pulled hardest toward the chosen phase, for the log ("Next: work, for money").
export function strongestDrive(
  ctx: Pick<LifeContext, 'session' | 'checkpoint' | 'template'>,
  phase: LifePhase
): Drive | undefined {
  const now = drives(ctx);
  const weights = weightsOf(ctx.session.world.serial ?? 0);
  const [drive, score] =
    DRIVES.map((d) => [d, now[d] * weights[d] * (answers[d][phase] ?? 0)] as const).sort((a, b) => b[1] - a[1])[0] ??
    [];
  return drive && (score ?? 0) >= 0.2 ? drive : undefined;
}

// Fun was had (a leisure phase or a visit began).
export const hadFun = (serial: number) => lasting('fun', serial).set('at', Date.now() + 7 * 24 * HOUR);
