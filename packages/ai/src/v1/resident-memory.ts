import type { Episode, EpisodeKind, ResidentMemory } from './resident-memory-types';
import type { Checkpoint } from './store';

export function personalMemory(checkpoint: Checkpoint, now = Date.now()): ResidentMemory {
  if (checkpoint.personal && checkpoint.personal.version !== 1) throw new Error('Unsupported personal memory version');
  checkpoint.personal ??= { version: 1, episodes: [], partners: {}, orders: [], goals: [], strategies: [] };
  const memory = checkpoint.personal;
  memory.episodes = memory.episodes
    .filter((episode) => episode.at <= now && now - episode.at < 30 * 86400_000)
    .slice(-80);
  memory.orders = memory.orders.slice(-12);
  memory.goals = memory.goals.slice(-8);
  memory.strategies = memory.strategies.filter((place) => now - place.updatedAt < 7 * 86400_000).slice(-32);
  for (const [key] of Object.entries(memory.partners)
    .sort(([, a], [, b]) => b.lastAt - a.lastAt)
    .slice(40))
    delete memory.partners[key];
  return memory;
}

export function rememberPartner(
  checkpoint: Checkpoint,
  options: {
    partner: number;
    name: string;
    kind: EpisodeKind;
    detail: string;
    result?: Episode['result'];
    id?: string;
    at?: number;
  }
) {
  const now = options.at ?? Date.now();
  const memory = personalMemory(checkpoint, now);
  const id = options.id ?? `${options.kind}:${options.partner}:${now}`;
  if (memory.episodes.some((episode) => episode.id === id)) return;
  const result = options.result ?? 'observed';
  memory.episodes.push({
    id,
    at: now,
    kind: options.kind,
    partner: options.partner,
    name: options.name,
    detail: options.detail.slice(0, 220),
    result
  });
  const old = memory.partners[options.partner];
  const trust =
    result === 'interrupted' || (options.kind === 'order' && result !== 'completed')
      ? 0
      : options.kind === 'rescue'
        ? 0.2
        : options.kind === 'gift'
          ? 0.12
          : options.kind === 'conversation'
            ? 0.015
            : 0.08;
  const days = old ? Math.max(0, now - old.lastAt) / 86400_000 : 0;
  memory.partners[options.partner] = {
    name: options.name,
    trust: Math.min(1, (old?.trust ?? 0) * Math.exp(-days / 30) + trust),
    conversations: (old?.conversations ?? 0) + (options.kind === 'conversation' ? 1 : 0),
    lastAt: now
  };
  const relation = checkpoint.relationships[options.name];
  checkpoint.relationships[options.name] = {
    ...relation,
    affinity: memory.partners[options.partner]?.trust ?? 0,
    note: options.detail.slice(0, 220),
    lastSeen: new Date(now).toISOString()
  };
  personalMemory(checkpoint, now);
}

export function sharedMemoryLine(checkpoint: Checkpoint, partner: number): string | undefined {
  const memory = personalMemory(checkpoint);
  const episode = [...memory.episodes]
    .reverse()
    .find(
      (entry) =>
        entry.partner === partner &&
        entry.kind !== 'conversation' &&
        (entry.result === 'completed' || entry.kind === 'rescue' || entry.kind === 'gift')
    );
  if (!episode) return undefined;
  if (episode.kind === 'gift') return 'I remember the supplies you gave me. Thank you again.';
  if (episode.kind === 'rescue') return 'Good to see you. Thanks for helping me out back there.';
  if (episode.kind === 'support') return 'Good to see you again. Glad I could help you recover last time.';
  if (episode.kind === 'repair') return 'Good to see you. I hope that repair contract was useful.';
  if (episode.kind === 'plan') return 'Good to see you again. We got through our last plan together.';
  if (episode.kind === 'outing') return 'Good to see you again. That was a useful outing together.';
  if (episode.kind === 'trade' || episode.kind === 'order')
    return 'Good to see you again. Our last deal worked out well.';
  return undefined;
}
