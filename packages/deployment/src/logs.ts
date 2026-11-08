import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { railway } from './providers/railway';
import { readJson } from './state';

// gemwright shard logs: the recent log lines of each deployed service, merged in time order and labelled
// with the service they came from; --watch keeps following them. Lines are read through the
// installed Railway CLI each time and never stored. A piped `railway logs` does not stream, so
// following asks each service for what arrived since its last line.
export interface LogParts {
  server?: boolean;
  client?: boolean;
  ai?: boolean;
  watch?: boolean;
}
type Part = 'server' | 'client' | 'ai';
interface Line {
  timestamp: string;
  message: string;
}
const RECENT = 200;
const POLL_MS = 5000;

export async function logs(
  parts: LogParts,
  directory = process.cwd(),
  print: (line: string) => void = console.log,
  warn: (line: string) => void = console.error,
  following = () => true
): Promise<void> {
  type State = { project?: string; environment?: string; service?: string };
  const recorded: Record<Part, State | undefined> = {
    server: await readJson<State>(join(directory, '.gemwright/railway.json')),
    client: await readJson<State>(join(directory, '.gemwright/webclient.json')),
    ai: await readJson<State>(join(directory, '.gemwright/ai.json'))
  };
  const project = recorded.server?.project ?? recorded.ai?.project;
  if (!project) throw new Error('No Railway deployment found here.');
  const scope = [
    '--project',
    project,
    '--environment',
    recorded.server?.environment ?? recorded.ai?.environment ?? 'production'
  ];
  const all = !parts.server && !parts.client && !parts.ai;
  const services = (['server', 'client', 'ai'] as const).flatMap((part) => {
    if (!all && !parts[part]) return [];
    const service = recorded[part]?.service;
    if (!service) warn(`No ${part} deployment is recorded here.`);
    return service ? [{ part, service }] : [];
  });
  if (!services.length) throw new Error('None of the selected services is deployed here.');

  const read = async (service: string, window: string[]) =>
    (await railway(['logs', ...scope, '--service', service, ...window, '--json'], directory))
      .split('\n')
      .flatMap((text): Line[] => {
        try {
          const line = JSON.parse(text) as Partial<Line>;
          return typeof line.timestamp === 'string' ? [{ timestamp: line.timestamp, message: line.message ?? '' }] : [];
        } catch {
          return text.trim() ? [{ timestamp: '', message: text }] : [];
        }
      });
  // A window starting at a service's newest line repeats the lines of that moment: those are kept
  // to skip, and nothing older.
  const seen = new Map<string, Set<string>>();
  const last = new Map<string, string>();
  const key = (line: Line) => `${line.timestamp} ${line.message}`;
  const show = (batches: { part: Part; service: string; lines: Line[] }[]) => {
    const fresh = batches.flatMap(({ part, service, lines }) => {
      const printed = seen.get(service) ?? new Set<string>();
      const unseen = lines.filter((line) => !printed.has(key(line)));
      const newest = [last.get(service) ?? '', ...lines.map((line) => line.timestamp)].sort().at(-1) ?? '';
      last.set(service, newest);
      seen.set(service, new Set([...printed, ...unseen.map(key)].filter((entry) => entry.startsWith(`${newest} `))));
      return unseen.map((line) => ({ part, ...line }));
    });
    for (const line of fresh.sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
      print(`${line.timestamp} [${line.part}] ${line.message}`);
  };

  show(
    await Promise.all(
      services.map(async ({ part, service }) => ({
        part,
        service,
        lines: await read(service, ['--lines', String(RECENT)])
      }))
    )
  );
  while (parts.watch && following()) {
    await sleep(POLL_MS);
    show(
      await Promise.all(
        services.map(async ({ part, service }) => ({
          part,
          service,
          lines: await read(service, last.get(service) ? ['--since', last.get(service) ?? ''] : ['--lines', '50'])
        }))
      )
    );
  }
}
