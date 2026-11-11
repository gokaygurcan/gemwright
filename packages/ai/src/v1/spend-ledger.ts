import type { Database } from 'bun:sqlite';

// Jev input tokens charged per UTC day by the whole population, in the residents database so a
// restart or redeploy never resets the day's spend. Each resident's coordinator checks it against
// the population cap before a request and records the reservation, then the settled usage.
export class SpendLedger {
  constructor(
    private readonly db: Database,
    private readonly durable?: () => Promise<void>
  ) {
    db.run('CREATE TABLE IF NOT EXISTS decision_spend (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL)');
    db.run(`CREATE TABLE IF NOT EXISTS decision_provider_spend (
      day TEXT NOT NULL, provider TEXT NOT NULL, units INTEGER NOT NULL,
      PRIMARY KEY (day, provider)
    );
    CREATE TABLE IF NOT EXISTS decision_provider_cooldown (
      provider TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, reason TEXT NOT NULL
    )`);
  }
  tokens(day: string): number {
    return (
      this.db
        .query<{ input_tokens: number }, [string]>('SELECT input_tokens FROM decision_spend WHERE day = ?')
        .get(day)?.input_tokens ?? 0
    );
  }
  add(day: string, tokens: number) {
    this.db
      .query(
        `INSERT INTO decision_spend (day, input_tokens) VALUES (?, ?)
         ON CONFLICT (day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens`
      )
      .run(day, tokens);
    return this.durable?.();
  }

  units(day: string, provider: string): number {
    if (provider === 'jev') return this.tokens(day);
    return (
      this.db
        .query<{ units: number }, [string, string]>(
          'SELECT units FROM decision_provider_spend WHERE day = ? AND provider = ?'
        )
        .get(day, provider)?.units ?? 0
    );
  }

  reserve(day: string, provider: string, units: number, limit: number): boolean {
    return this.db.transaction(() => {
      if (this.units(day, provider) + units > limit) return false;
      this.adjust(day, provider, units);
      return true;
    })();
  }

  adjust(day: string, provider: string, units: number): void {
    if (provider === 'jev') {
      this.db
        .query(`INSERT INTO decision_spend (day, input_tokens) VALUES (?, ?)
        ON CONFLICT (day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens`)
        .run(day, units);
    } else {
      this.db
        .query(`INSERT INTO decision_provider_spend (day, provider, units) VALUES (?, ?, ?)
        ON CONFLICT (day, provider) DO UPDATE SET units = units + excluded.units`)
        .run(day, provider, units);
    }
  }

  cooldown(provider: string, now: number): string | undefined {
    const row = this.db
      .query<{ until_ms: number; reason: string }, [string]>(
        'SELECT until_ms, reason FROM decision_provider_cooldown WHERE provider = ?'
      )
      .get(provider);
    return row && row.until_ms > now ? row.reason : undefined;
  }

  block(provider: string, until: number, reason: string): void {
    this.db
      .query(`INSERT INTO decision_provider_cooldown (provider, until_ms, reason) VALUES (?, ?, ?)
      ON CONFLICT (provider) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms), reason = excluded.reason`)
      .run(provider, until, reason);
  }

  async flush(): Promise<void> {
    await this.durable?.();
  }
}
