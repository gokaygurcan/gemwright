import type { HistoryEvent } from './history';

export class CareMemory {
  deaths: { at: number; x?: number; y?: number; map?: number | null }[] = [];
  stranded: number[] = [];
  mending = false;
  corpse?: { at: number; x: number; y: number; z: number; map: number | null };
  corpseTried?: number;
  rode = false;
  claimAfter = 0;
  helpAfter = 0;
  helpUses: number[] = [];
  knownSpells = new Set<number>();
  spending: { at: number; amount: number }[] = [];
  cooldowns = new Map<string, number>();

  observe(event: HistoryEvent) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === 'awake' || event.kind === 'care')
      for (const [key, until] of this.cooldowns) if (until <= event.at) this.cooldowns.delete(key);
    if (event.kind === 'died') {
      this.deaths = [...this.deaths.filter((d) => event.at - d.at < 3_600_000), { at: event.at, ...event.where }];
      if (event.where) this.corpse = { at: event.at, ...event.where };
      this.mending = true;
    }
    if (['revealed', 'gained', 'changed'].includes(event.kind) && data.layer === 25) {
      this.rode = true;
      this.claimAfter = 0;
    }
    if (event.kind === 'care') {
      const action = String(data.action);
      if (action === 'training-spent' && typeof data.amount === 'number') {
        this.spending = this.spending.filter((s) => event.at - s.at < 3_600_000);
        this.spending.push({ at: event.at, amount: data.amount });
      }
      if (action === 'spell-known') this.knownSpells.add(Number(data.spell));
      if (action === 'corpse-failed') this.corpseTried = this.corpse?.at;
      if (action === 'corpse') this.corpse = undefined;
      if (action === 'claim') {
        this.claimAfter = event.at + 3_600_000;
        if (data.answer === 'none') this.rode = false;
      }
      if (action === 'help-request') this.helpAfter = event.at + 30 * 60_000;
      if (action === 'help-used') this.helpUses.push(event.at);
      if (typeof data.until === 'number') this.cooldowns.set(String(data.key), data.until);
    }
    if (event.kind === 'spell-missing') this.knownSpells.delete(Number(data.spell));
    if (event.kind === 'stranded') this.stranded.push(event.at);
    if (event.kind === 'self' || event.kind === 'awake') {
      const self = event.kind === 'awake' ? data.self : data;
      const health = (self as { health?: { current: number; max: number } } | undefined)?.health;
      if (health && health.current >= health.max * 0.8) this.mending = false;
    }
  }

  trainingSpent(now = Date.now()) {
    return this.spending.filter((s) => now - s.at < 3_600_000).reduce((sum, s) => sum + s.amount, 0);
  }

  needsHelp(now = Date.now()) {
    this.deaths = this.deaths.filter((d) => now - d.at < 3_600_000);
    this.stranded = this.stranded.filter((at) => now - at < 3_600_000);
    this.helpUses = this.helpUses.filter((at) => now - at < 24 * 3_600_000);
    return now >= this.helpAfter && this.helpUses.length < 2 && (this.deaths.length >= 3 || this.stranded.length >= 3);
  }
}
