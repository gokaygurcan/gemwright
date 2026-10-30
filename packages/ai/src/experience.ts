import { type CombatCapability, comparableCapability } from './combat-capability';
import type { Checkpoint } from './store';

interface Place {
  map: number;
  x: number;
  y: number;
}
interface BaseEvent extends Place {
  id: string;
  at: number;
}
export type ExperienceEvent =
  | (BaseEvent & {
      kind: 'combat';
      capability?: CombatCapability;
      creatureName?: string;
      body: number;
      outcome: 'victory' | 'retreat' | 'death' | 'interrupted';
      largestLossRatio: number;
      lowestHealthRatio: number;
      damageRatio: number;
    })
  | (BaseEvent & { kind: 'bandage'; outcome: 'success' | 'failure' | 'unknown'; skill: number | null })
  | (BaseEvent & { kind: 'recovery'; outcome: 'recovered' | 'abandoned' | 'failed-break' | 'reengaged' })
  | (BaseEvent & {
      kind: 'service';
      vendor: number;
      action: number;
      needs?: number[];
      outcome: 'success' | 'unreachable' | 'unavailable' | 'no-stock' | 'no-service' | 'no-answer';
    });
export interface ExperienceMemory {
  schemaVersion: 1;
  events: ExperienceEvent[];
}
const hour = 3_600_000;
const limits = { combat: 24, bandage: 24, recovery: 16, service: 32 };
const retention = { combat: 7 * 24 * hour, bandage: 24 * hour, recovery: 3 * 24 * hour, service: 24 * hour };
const nearby = (a: Place, b: Place, radius: number) =>
  a.map === b.map && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= radius;

export function reconcileExperience(checkpoint: Checkpoint, now = Date.now()): void {
  if (checkpoint.experience && checkpoint.experience.schemaVersion !== 1)
    throw new Error('Unsupported experience schema');
  checkpoint.experience ??= { schemaVersion: 1, events: [] };
  const counts = { combat: 0, bandage: 0, recovery: 0, service: 0 };
  const ids = new Set<string>();
  checkpoint.experience.events = checkpoint.experience.events
    .filter((event) => Number.isFinite(event.at) && event.at <= now && now - event.at <= retention[event.kind])
    .sort((a, b) => a.at - b.at)
    .reverse()
    .filter((event) => {
      if (ids.has(event.id) || counts[event.kind] >= limits[event.kind]) return false;
      ids.add(event.id);
      counts[event.kind]++;
      return true;
    })
    .reverse();
}

export function rememberExperience(checkpoint: Checkpoint, event: ExperienceEvent, now = Date.now()): void {
  reconcileExperience(checkpoint, now);
  const memory = checkpoint.experience;
  if (!memory) throw new Error('Experience initialization failed');
  const previous = memory.events.find((old) => old.id === event.id);
  // An uncertain continuation can never downgrade a previously confirmed outcome.
  if (
    previous?.kind === 'combat' &&
    previous.outcome !== 'interrupted' &&
    event.kind === 'combat' &&
    event.outcome === 'interrupted'
  )
    return;
  memory.events = memory.events.filter((old) => old.id !== event.id);
  memory.events.push(structuredClone(event));
  reconcileExperience(checkpoint, now);
}

export function encounterAdvice(
  checkpoint: Checkpoint,
  place: Place,
  body: number,
  now = Date.now(),
  current?: CombatCapability,
  creatureName?: string
) {
  const events = (checkpoint.experience?.events ?? []).filter(
    (event): event is Extract<ExperienceEvent, { kind: 'combat' }> =>
      event.kind === 'combat' &&
      event.body === body &&
      (!creatureName || !event.creatureName || creatureName.toLowerCase() === event.creatureName.toLowerCase()) &&
      nearby(event, place, 64) &&
      event.at <= now &&
      now - event.at < 24 * hour &&
      event.outcome !== 'interrupted'
  );
  let caution = 0,
    avoidUntil = 0,
    adverse = 0,
    victories = 0,
    lastAdverse = 0;
  for (const event of events) {
    const age = now - event.at;
    const relevance = comparableCapability(event.capability, current);
    const weight = Math.max(0, 1 - age / (24 * hour)) * relevance;
    const dangerous =
      event.outcome === 'death' ||
      event.largestLossRatio >= 0.35 ||
      (event.outcome === 'retreat' && event.damageRatio > 0) ||
      event.lowestHealthRatio < 0.35;
    if (dangerous) {
      if (relevance >= 0.5) {
        adverse++;
        lastAdverse = Math.max(lastAdverse, event.at);
      }
      caution += (event.outcome === 'death' ? 0.4 : 0.2) * weight;
    }
    if (event.outcome === 'victory') victories++;
    if (relevance < 0.5) continue;
    if (event.outcome === 'death') avoidUntil = Math.max(avoidUntil, event.at + 10 * 60_000);
    else if (event.outcome === 'retreat' && event.largestLossRatio >= 0.35)
      avoidUntil = Math.max(avoidUntil, event.at + 5 * 60_000);
    // An emergency-grade retreat (health driven below 45% or a single hit of 30%+) is a clear loss.
    if (event.outcome === 'retreat' && (event.lowestHealthRatio < 0.45 || event.largestLossRatio >= 0.3))
      avoidUntil = Math.max(avoidUntil, event.at + 15 * 60_000);
  }
  // Repeatedly losing to the same kind of opponent here means it is beyond the character for now.
  if (adverse >= 2) {
    avoidUntil = Math.max(avoidUntil, lastAdverse + 60 * 60_000);
  }
  return {
    provenance: 'inferred-from-observed-encounters' as const,
    body,
    samples: events.length,
    adverse,
    victories,
    caution: Math.min(0.6, caution),
    avoidUntil: avoidUntil > now ? avoidUntil : 0,
    largestObservedLossRatio: Math.max(0, ...events.map((event) => event.largestLossRatio))
  };
}

export function bandageAdvice(checkpoint: Checkpoint, skill: number | null, now = Date.now()) {
  const events = (checkpoint.experience?.events ?? []).filter(
    (event): event is Extract<ExperienceEvent, { kind: 'bandage' }> =>
      event.kind === 'bandage' &&
      event.outcome !== 'unknown' &&
      event.at <= now &&
      now - event.at < 6 * hour &&
      (skill === null || event.skill === null || Math.abs(skill - event.skill) <= 10)
  );
  const successes = events.filter((event) => event.outcome === 'success').length;
  const failures = events.length - successes;
  return {
    samples: events.length,
    successes,
    failures,
    unreliable: events.length >= 3 && successes / events.length < 0.25
  };
}

const SERVICE_COOLDOWN: Record<string, number> = {
  'no-service': 6 * 3_600_000,
  'no-answer': 30 * 60_000,
  unavailable: 30 * 60_000,
  'no-stock': 30 * 60_000,
  unreachable: 5 * 60_000
};

export function serviceAdvice(
  checkpoint: Checkpoint,
  place: Place,
  vendor: number,
  action: number,
  now = Date.now(),
  needs: readonly number[] = []
) {
  const events = (checkpoint.experience?.events ?? []).filter(
    (event): event is Extract<ExperienceEvent, { kind: 'service' }> =>
      event.kind === 'service' &&
      (event.outcome !== 'no-stock' ||
        JSON.stringify(event.needs ?? []) === JSON.stringify([...needs].sort((a, b) => a - b))) &&
      event.vendor === vendor &&
      event.action === action &&
      nearby(event, place, 12) &&
      event.at <= now &&
      now - event.at < 24 * hour
  );
  const last = events.at(-1);
  const failures = events.filter(
    (event) =>
      event.outcome !== 'success' && (!last || event.at >= (events.findLast((e) => e.outcome === 'success')?.at ?? 0))
  ).length;
  // How long a vendor's answer holds. A service the vendor does not offer at all changes only when
  // the vendor's own state does (hours); an offered action that stays silent is a closed or busy
  // shop (half an hour); a failed route is tried sooner, and a stock-out sooner still. The old
  // five-minute cap meant a resident walked back to the same silent vendor all evening.
  const wait = SERVICE_COOLDOWN[last?.outcome ?? ''] ?? Math.min(5 * 60_000, 30_000 * 2 ** Math.min(4, failures));
  return {
    cooldownUntil: last && last.outcome !== 'success' && last.at + wait > now ? last.at + wait : 0,
    successful: !!last && last.outcome === 'success'
  };
}

export function experienceSummary(checkpoint: Checkpoint, place: Place, skill: number | null, now = Date.now()) {
  const bodies = [
    ...new Set(
      (checkpoint.experience?.events ?? [])
        .filter((event) => event.kind === 'combat' && nearby(event, place, 96))
        .flatMap((event) => (event.kind === 'combat' ? [event.body] : []))
    )
  ].slice(-4);
  return {
    provenance: 'confirmed-local-executor-outcomes',
    encounters: bodies.map((body) => encounterAdvice(checkpoint, place, body, now)),
    selfBandaging: bandageAdvice(checkpoint, skill, now),
    recovery: (checkpoint.experience?.events ?? [])
      .filter(
        (event) =>
          event.kind === 'recovery' && nearby(event, place, 128) && event.at <= now && now - event.at < 24 * hour
      )
      .slice(-3)
      .map((event) => ({ at: event.at, outcome: event.outcome })),
    services: (checkpoint.experience?.events ?? [])
      .filter(
        (event) =>
          event.kind === 'service' && nearby(event, place, 256) && event.at <= now && now - event.at < 24 * hour
      )
      .slice(-4)
      .flatMap((event) =>
        event.kind === 'service' ? [{ at: event.at, action: event.action, outcome: event.outcome }] : []
      )
  };
}
