import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import type { Lived } from '../lived';
import type { Runs } from '../runs';
import type { LabResponse, Scenario, SpanChange, SpanRequest, SpanResident, SpanStatus } from './types';

// The lab behind the analyzer's /lab page: a worker (worker.ts) that makes one decision again as it
// was and with a scenario changed, and a few more for a scenario over many decisions, each part of a
// stretch begun from a mind the resident's run kept (runs.ts, <pull>/runs/minds/<resident>).
const REPLY = '\u0001';
// From source beside this file; built, bundled into serve.js with the worker under lab/.
const worker = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './lab/worker.js', import.meta.url).pathname;
const HOUR = 3_600_000;
// Decisions a part of a stretch takes at least, before another worker takes the rest.
const PART = 300;
const POOL = Math.max(1, Math.min(6, availableParallelism() - 3));

type Reply = Record<string, unknown>;

class Worker {
  private readonly child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  private readonly waiting: ((line: Reply) => void)[] = [];
  // Lines it answered before anyone asked for them, in order.
  private readonly unclaimed: Reply[] = [];
  private buffer = '';
  readonly ready: Promise<void>;
  exited = false;

  constructor(land: string, minds: string) {
    this.child = Bun.spawn([process.execPath, worker, '--data', land, '--minds', minds], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    this.child.exited.then(() => {
      this.exited = true;
      for (const resolve of this.waiting.splice(0)) resolve({ error: 'The lab worker stopped.', done: true });
    });
    this.ready = this.read();
  }

  private async read() {
    const decoder = new TextDecoder();
    for await (const chunk of this.child.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let end = this.buffer.indexOf('\n');
      while (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith(REPLY)) {
          const reply = JSON.parse(line.slice(1)) as Reply;
          const waiter = this.waiting.shift();
          if (waiter) waiter(reply);
          else this.unclaimed.push(reply);
        }
        end = this.buffer.indexOf('\n');
      }
    }
  }

  // The next line it answers with.
  next() {
    const ready = this.unclaimed.shift();
    if (ready) return Promise.resolve(ready);
    if (this.exited) return Promise.resolve<Reply>({ error: 'The lab worker stopped.', done: true });
    return new Promise<Reply>((resolve) => this.waiting.push(resolve));
  }

  send(request: object) {
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    this.child.stdin.flush();
  }

  stop() {
    this.child.kill();
  }
}

export class Lab {
  private interactive?: Worker;
  private queue = Promise.resolve();
  private span?: SpanStatus & { workers: Worker[] };

  constructor(
    // The pull folder (ai/history.sqlite, runs/).
    readonly pull: string,
    private readonly lived: Lived,
    private readonly runs: Runs,
    private readonly land: () => Promise<string>
  ) {}

  private get minds() {
    return join(this.pull, 'runs/minds');
  }

  // How many minds each resident's run kept: none, and the lab cannot make its decisions again yet.
  kept(resident: string) {
    const folder = join(this.minds, resident);
    return existsSync(folder) ? readdirSync(folder).length : 0;
  }

  // One decision as it was, made again, and made again with a scenario changed.
  weigh(id: number, scenario: Scenario): Promise<LabResponse & { near: { previous?: number; next?: number } }> {
    const run = this.queue.then(async () => {
      if (!this.interactive || this.interactive.exited) this.interactive = new Worker(await this.land(), this.minds);
      const reply = this.interactive.next();
      this.interactive.send({ op: 'weigh', id, scenario, name: this.nameOf(id) });
      const answer = await reply;
      if (answer.error) throw new Error(String(answer.error));
      return { ...(answer.ok as LabResponse), near: this.near(id) };
    });
    this.queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // Another pull opened: its workers are of no more use.
  stop() {
    this.stopSpan();
    this.interactive?.stop();
  }

  // A run newly finished keeps new minds: the worker reads them afresh.
  forget() {
    if (this.interactive && !this.interactive.exited) {
      this.interactive.next();
      this.interactive.send({ op: 'forget' });
    }
  }

  private nameOf(id: number) {
    const db = new Database(this.lived.file, { readonly: true });
    try {
      const resident = db
        .query<{ resident: string }, [number]>('SELECT resident FROM events WHERE id = ?')
        .get(id)?.resident;
      return resident ? (this.lived.residents.get(resident)?.name ?? resident.slice(0, 8)) : '';
    } finally {
      db.close();
    }
  }

  // The resident's decisions just before and after one.
  private near(id: number) {
    const db = new Database(this.lived.file, { readonly: true });
    try {
      const row = db
        .query<{ resident: string; at: number }, [number]>('SELECT resident, at FROM events WHERE id = ?')
        .get(id);
      if (!row) return {};
      const find = (op: '<' | '>') =>
        ['considered', 'reconsidered']
          .flatMap(
            (kind) =>
              db
                .query<{ id: number }, [string, string, number, number]>(
                  `SELECT id FROM events WHERE resident = ? AND kind = ? AND at ${op}= ? AND id ${op} ? ORDER BY at ${op === '<' ? 'DESC' : 'ASC'}, id ${op === '<' ? 'DESC' : 'ASC'} LIMIT 1`
                )
                .get(row.resident, kind, row.at, id) ?? []
          )
          .map((r) => r.id)
          .sort((a, b) => (op === '<' ? b - a : a - b))[0];
      return { previous: find('<'), next: find('>') };
    } finally {
      db.close();
    }
  }

  spanStatus(): SpanStatus | undefined {
    if (!this.span) return undefined;
    const { workers: _, ...status } = this.span;
    return status;
  }

  stopSpan() {
    if (!this.span) return;
    for (const w of this.span.workers) w.stop();
    this.span.running = false;
    this.span.finished = Date.now();
  }

  // A scenario over each chosen resident's decisions in the hours up to a moment (the history's newest event),
  // each against what the same decision came to made again unchanged (its resident's run).
  async startSpan(request: SpanRequest) {
    this.stopSpan();
    const until = request.until ?? this.lived.newest;
    const since = until - request.hours * HOUR;
    const parts: { resident: string; first: number; last: number }[] = [];
    const residents: SpanResident[] = [];
    // Shown as under way at once, its residents filled in as its parts are laid out.
    const span: SpanStatus & { workers: Worker[] } = {
      id: crypto.randomUUID(),
      running: true,
      started: Date.now(),
      request,
      residents,
      changes: [],
      workers: []
    };
    this.span = span;
    const land = await this.land();
    const db = new Database(this.lived.file, { readonly: true });
    try {
      for (const resident of request.residents) {
        const keptAt = new Set(
          existsSync(join(this.minds, resident))
            ? readdirSync(join(this.minds, resident)).map((f) => Number(f.split('.')[0]))
            : []
        );
        const earliest = Math.min(...keptAt);
        const all = db
          .query<{ id: number; at: number }, [string, number, number]>(
            "SELECT id, at FROM events WHERE resident = ? AND kind IN ('considered', 'reconsidered') AND at >= ? AND at <= ? ORDER BY id"
          )
          .all(resident, since, until);
        const ids = all.filter((d) => d.id >= earliest);
        residents.push({
          resident,
          name: this.lived.residents.get(resident)?.name ?? resident.slice(0, 8),
          total: ids.length,
          done: 0,
          changed: 0,
          skipped: keptAt.size ? all.length - ids.length : all.length,
          before: {},
          after: {},
          ...(keptAt.size ? {} : { error: 'No minds kept: run it on the Choices page first.' })
        });
        if (!keptAt.size || !ids.length) continue;
        // Parts start where a mind was kept, at least PART decisions apart.
        let start = 0;
        for (let i = 1; i <= ids.length; i++) {
          const boundary = i === ids.length || (i - start >= PART && keptAt.has((ids[i] as { id: number }).id));
          if (!boundary) continue;
          parts.push({
            resident,
            first: (ids[start] as { id: number }).id,
            last: (ids[i - 1] as { id: number }).id
          });
          start = i;
        }
      }
    } finally {
      db.close();
    }
    if (!span.running) return;
    const workers = Array.from({ length: Math.min(POOL, parts.length) }, () => new Worker(land, this.minds));
    span.workers.push(...workers);
    const byResident = new Map(residents.map((r) => [r.resident, r]));
    const before = new Map(request.residents.map((r) => [r, this.runs.decisions(r)]));
    const plan = (chose: string) => /\(([^)]*)\)$/.exec(chose)?.[1] ?? chose;
    const count = (into: Record<string, number>, key: string) => {
      into[key] = (into[key] ?? 0) + 1;
    };
    await Promise.all(
      workers.map(async (w) => {
        while (span.running) {
          const part = parts.shift();
          if (!part) break;
          const entry = byResident.get(part.resident) as SpanResident;
          w.send({ op: 'span', ...part, scenario: request.scenario });
          for (;;) {
            const line = await w.next();
            if (line.done || !span.running) {
              if (line.error) entry.error = String(line.error);
              break;
            }
            if (line.id === undefined) continue;
            entry.done++;
            const was = before.get(part.resident)?.get(Number(line.id))?.chose as { replay?: string } | undefined;
            const now = String(line.chose ?? line.error ?? '');
            if (was?.replay) count(entry.before, plan(was.replay));
            count(entry.after, plan(now));
            if (was?.replay && was.replay !== now) {
              entry.changed++;
              span.changes.push({
                id: Number(line.id),
                resident: part.resident,
                at: Number(line.at),
                kind: String(line.kind),
                before: was.replay,
                after: now
              } satisfies SpanChange);
            }
          }
        }
        w.stop();
      })
    );
    span.running = false;
    span.finished = Date.now();
  }
}
