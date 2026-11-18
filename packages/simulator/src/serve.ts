import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { prepareLand } from '../../ai/src/land';
import page from '../web/index.html';
import { openHistory, Resident, residents } from './resident';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { land: { type: 'string' }, port: { type: 'string' } }
});
// The newest pull in this shard folder with a land (analyze copies it there), unless one is named.
const newest = () => {
  const pulls = resolve('.gemwright/pulls');
  if (!existsSync(pulls)) return undefined;
  return readdirSync(pulls)
    .sort()
    .reverse()
    .map((stamp) => join(pulls, stamp, 'land'))
    .find((land) => existsSync(join(land, 'history.sqlite')));
};
const land = values.land ?? newest();
if (!land || !existsSync(join(land, 'history.sqlite')))
  throw new Error('No land found: pass --land <pull>/land, or pull one with the analyzer first.');
const shard = JSON.parse(readFileSync(join(land, 'gemwright.json'), 'utf8')) as { ai?: { cities?: string[] } };
await prepareLand(land, shard.ai?.cities);
const history = openHistory(land);
const loaded = new Map<string, Resident>();
const resident = (name: string) => {
  const found = loaded.get(name) ?? new Resident(history, name);
  loaded.set(name, found);
  return found;
};
const reply = (work: () => unknown) => {
  try {
    return Response.json(work());
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
};

// Each change a resident can be given, from the page's request body.
type Body = Record<string, unknown>;
const changes: Record<string, (r: Resident, b: Body) => void> = {
  edit: (r, b) => r.edit(b.path as string[], b.value),
  pin: (r, b) => r.pin(String(b.key), b.value),
  tune: (r, b) => r.tune(b.values as Parameters<Resident['tune']>[0]),
  act: (r, b) =>
    r.act(
      String(b.id),
      b.succeeded === true,
      b.seconds as number | undefined,
      (b.events ?? []) as Parameters<Resident['act']>[3]
    ),
  tell: (r, b) => r.tell(b as Parameters<Resident['tell']>[0]),
  wait: (r, b) => r.wait(Number(b.seconds)),
  undo: (r) => r.undo()
};

const server = Bun.serve({
  port: Number(values.port ?? 4200),
  routes: {
    '/': page,
    '/api/residents': () => Response.json(residents(land)),
    '/api/residents/:name': (req) => reply(() => resident(req.params.name).view()),
    '/api/residents/:name/state': {
      POST: async (req) => {
        const { path } = (await req.json()) as { path: string[] };
        return reply(() => resident(req.params.name).state(path));
      }
    },
    '/api/residents/:name/reset': {
      POST: (req) =>
        reply(() => {
          loaded.delete(req.params.name);
          return resident(req.params.name).view();
        })
    },
    '/api/residents/:name/:change': {
      POST: async (req) => {
        const body = (await req.json()) as Body;
        return reply(() => {
          const change = changes[req.params.change];
          if (!change) throw new Error(`No change ${req.params.change}.`);
          const r = resident(req.params.name);
          change(r, body);
          return r.view();
        });
      }
    }
  }
});
console.log(`Simulator on http://localhost:${server.port} over ${land}`);
