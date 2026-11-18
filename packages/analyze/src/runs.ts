import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';

// Decisions made again (replay-runner.ts), a resident at a time in the background, a few at once:
// each run's lines kept in <pull>/runs/<resident>.jsonl and its output in <resident>.log, read back
// by the pages beside what each decision was live.
export interface RunLine {
  type: 'start' | 'wake' | 'decision' | 'end' | 'error';
  [key: string]: unknown;
}
export interface RunState {
  status: 'queued' | 'fetching' | 'running' | 'done' | 'failed' | 'stopped';
  since: number;
  until: number;
  error?: string;
}

const runner = new URL(import.meta.url.endsWith('.ts') ? './replay-runner.ts' : './replay-runner.js', import.meta.url)
  .pathname;
const AT_ONCE = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3)));

export class Runs {
  private readonly states = new Map<string, RunState>();
  private readonly queue: string[] = [];
  private readonly children = new Map<string, ReturnType<typeof Bun.spawn>>();
  private readonly cache = new Map<string, { size: number; lines: RunLine[]; decisions: Map<number, RunLine> }>();
  private running = 0;

  constructor(
    // The pull folder (holding ai/history.sqlite).
    readonly pull: string,
    // The land folder to run in, fetched on first use.
    private readonly land: () => Promise<string>,
    // Told when a run has ended, its kept minds then complete.
    private readonly ended: (resident: string) => void = () => {}
  ) {}

  private file(resident: string, ext = 'jsonl') {
    return join(this.pull, 'runs', `${resident}.${ext}`);
  }

  state(resident: string): RunState | undefined {
    return this.states.get(resident);
  }

  get busy() {
    return [...this.states.values()].some(
      (s) => s.status === 'queued' || s.status === 'running' || s.status === 'fetching'
    );
  }

  start(resident: string, since: number, until: number) {
    const state = this.states.get(resident);
    if (state && (state.status === 'queued' || state.status === 'running' || state.status === 'fetching')) return;
    this.states.set(resident, { status: 'queued', since, until });
    this.queue.push(resident);
    this.next();
  }

  stop(resident: string) {
    const state = this.states.get(resident);
    if (!state) return;
    const queued = this.queue.indexOf(resident);
    if (queued >= 0) this.queue.splice(queued, 1);
    this.children.get(resident)?.kill();
    state.status = 'stopped';
  }

  stopAll() {
    for (const resident of this.states.keys()) this.stop(resident);
  }

  private next() {
    while (this.running < AT_ONCE && this.queue.length) {
      const resident = this.queue.shift() as string;
      const state = this.states.get(resident) as RunState;
      state.status = 'fetching';
      this.running++;
      this.land()
        .then((land) => {
          if (state.status !== 'fetching') return;
          mkdirSync(dirname(this.file(resident)), { recursive: true });
          state.status = 'running';
          const child = Bun.spawn(
            [
              process.execPath,
              runner,
              '--data',
              land,
              '--resident',
              resident,
              '--since',
              String(state.since),
              '--until',
              String(state.until),
              '--out',
              this.file(resident),
              // The mind as it stood every so often, for the lab to take up (lab/lab.ts).
              '--minds',
              join(this.pull, 'runs/minds', resident)
            ],
            { stdout: Bun.file(this.file(resident, 'log')), stderr: 'pipe' }
          );
          this.children.set(resident, child);
          return Promise.all([child.exited, new Response(child.stderr).text()]).then(([code, stderr]) => {
            if (state.status === 'running') {
              const last = this.lines(resident).at(-1);
              state.status = code === 0 && last?.type === 'end' ? 'done' : 'failed';
              if (state.status === 'failed')
                state.error = String(
                  last?.type === 'error'
                    ? last.message
                    : stderr.trim().split('\n').slice(-5).join('\n') || `exit ${code}`
                );
            }
          });
        })
        .catch((error: unknown) => {
          state.status = 'failed';
          state.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.children.delete(resident);
          this.running--;
          this.ended(resident);
          this.next();
        });
    }
  }

  // A run's lines so far (this server's, or one an earlier server left in the pull).
  lines(resident: string): RunLine[] {
    return this.read(resident).lines;
  }

  // Each replayed decision by its id.
  decisions(resident: string) {
    return this.read(resident).decisions;
  }

  private read(resident: string) {
    const file = this.file(resident);
    if (!existsSync(file)) return { lines: [], decisions: new Map<number, RunLine>() };
    const size = statSync(file).size;
    const cached = this.cache.get(resident);
    if (cached?.size === size) return cached;
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as RunLine] : [];
        } catch {
          return [];
        }
      });
    const read = {
      size,
      lines,
      decisions: new Map(lines.filter((l) => l.type === 'decision').map((l) => [Number(l.id), l]))
    };
    this.cache.set(resident, read);
    return read;
  }
}
