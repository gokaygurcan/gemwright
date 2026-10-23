import type { Database } from 'bun:sqlite';

// Jev input tokens charged per UTC day by the whole population, in the residents database so a
// restart or redeploy never resets the day's spend. Each resident's coordinator checks it against
// the population cap before a request and records the reservation, then the settled usage.
export class SpendLedger {
  constructor(private readonly db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS decision_spend (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL)');
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
  }
}
