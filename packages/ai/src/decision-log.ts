import type { Database } from 'bun:sqlite';

import type { ChoiceRequest, ProviderAttempt } from './decision-provider';
import type { DecisionTrace } from './decisions';

// Every question a resident's coordinator settled: the request as offered (its state, instructions
// and options) and what came back, from Clef, Jev or the local rules. The analyzer lists them
// (packages/analyze/src/questions.ts). Request and response are gzipped JSON, about a tenth of
// their size, and a week is kept, so a pull of the database stays small.
const KEEP_MS = 7 * 86_400_000;

export class DecisionLog {
  private writes = 0;
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS decision_log (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      resident_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      selected TEXT,
      baseline TEXT NOT NULL,
      request BLOB NOT NULL,
      response BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decision_log_at ON decision_log (at)`);
  }

  record(residentId: string, trace: DecisionTrace, request: ChoiceRequest, exchanges?: ProviderAttempt[]) {
    // The provider that answered: the attempt that returned a validated choice, else local rules.
    const answered = trace.attempts?.find((attempt) => attempt.reason === 'validated-choice');
    const response = {
      selected: trace.selected,
      proposal: trace.proposal,
      confidence: trace.confidence,
      probabilities: trace.probabilities,
      baseline: trace.baseline,
      // Each provider asked, with the exact body sent and the body received.
      attempts: exchanges ?? trace.attempts,
      latencyMs: trace.latencyMs,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens
    };
    this.db
      .query(`INSERT OR REPLACE INTO decision_log
        (id, at, resident_id, kind, source, reason, provider, model, selected, baseline, request, response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        trace.id,
        Date.parse(trace.at),
        residentId,
        trace.kind,
        trace.source,
        trace.reason,
        answered?.provider ?? 'local',
        trace.resolvedModel ?? answered?.model ?? 'local',
        trace.selected,
        trace.baseline,
        Bun.gzipSync(JSON.stringify(request)),
        Bun.gzipSync(JSON.stringify(response))
      );
    if (++this.writes % 500 === 0) this.db.query('DELETE FROM decision_log WHERE at < ?').run(Date.now() - KEEP_MS);
  }
}
