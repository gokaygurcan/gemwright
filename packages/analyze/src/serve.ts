import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadShard } from '@gemwright/common/config/shard';
import { pull } from '@gemwright/deployment/pull';
import { simulateDecision } from '@gemwright/deployment/simulate';
import { pullFrom } from '@gemwright/deployment/target';

import { type Analysis, analyze } from './analysis';
import { choiceDoc } from './choice';
import { choicesDoc, residentChoicesDoc, spanOf } from './choices';
import { findClientFiles } from './client';
import type { Doc } from './doc';
import { economyDoc } from './economy';
import { historyDoc, readHistory, recordHistory } from './history';
import { Lab } from './lab/lab';
import { labRoutes } from './lab/routes';
import { landOf } from './land';
import { readLived, withLived } from './lived';
import { livedDecisionsDoc, livedLoopsDoc, livedSpentDoc, livedTroubleDoc } from './lived-pages';
import { mapData } from './map';
import { mindsDoc } from './minds';
import { overviewDoc } from './overview';
import { itemDoc, mobileDoc, searchDoc } from './pages';
import { playersDoc } from './players';
import { deletePull, isStamp, listPulls, savesOf } from './pull-store';
import { savedAt } from './pulls';
import type { PullsResponse } from './pulls-api';
import { readPulse } from './pulse';
import { readResidents, residentsDoc } from './residents';
import { Runs } from './runs';
import { search } from './search';
import { eventDoc, simulationDoc, traceDoc } from './trace';

// The app: built with Tailwind by web/build.ts, read from dist/web when built, and from source
// rebuilt in memory on each page load (its scripts and styles come from the latest build).
const fromSource = import.meta.url.endsWith('.ts');
const buildWeb: (() => Promise<Blob[]>) | undefined = fromSource
  ? (await import(new URL('../web/build.ts', import.meta.url).href)).buildWeb
  : undefined;
let built = new Map<string, Blob>();
const app = async (request: Request) => {
  const path = new URL(request.url).pathname;
  const asset = path === '/index.js' ? 'index.js' : path === '/index.css' ? 'index.css' : 'index.html';
  if (!buildWeb) return new Response(Bun.file(new URL(`../web/${asset}`, import.meta.url)));
  if (asset === 'index.html' || !built.size)
    built = new Map((await buildWeb()).map((file) => [basename((file as Blob & { path: string }).path), file]));
  const file = built.get(asset);
  return file ? new Response(file) : new Response('Not found', { status: 404 });
};

// A local website over a shard's pulls (web/: a Preact app styled with Tailwind). Run from the
// shard folder (or given it with --shard), it opens on the list of pulls (.gemwright/pulls): fetch a new one from the
// deployment, delete one, or analyze one to search its characters, mobiles and items by name, type
// or serial. --local analyzes a Saves folder already on disk instead.
//   bun packages/analyze/src/serve.ts [--shard <folder>] [--local <Saves folder>] [--files <client files>] [--port 4100]
// With the game client's files (--files, else the repository's files/), character pages draw the
// character with the client's own art.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    shard: { type: 'string' },
    local: { type: 'string' },
    port: { type: 'string' },
    files: { type: 'string' }
  }
});
const client = findClientFiles(values.files);
const clientDirectory = client?.directory;
if (!client) console.log('No client files found: character pages show tables only (pass --files).');
const directory = resolve(values.shard ?? '.');

// The pull being analyzed, and what the pages read from it.
interface Open {
  stamp?: string;
  label: string;
  savedAt: string;
  analysis: Analysis;
  saves: string;
  residents: ReturnType<typeof readResidents>;
  history: ReturnType<typeof readHistory>;
  pulse: ReturnType<typeof readPulse>;
  lived: ReturnType<typeof readLived>;
  runs?: Runs;
  lab?: Lab;
}
let open: Open | undefined;
const load = (saves: string, label: string, stamp?: string) => {
  open?.runs?.stopAll();
  open?.lab?.stop();
  const started = performance.now();
  const analysis = analyze(saves);
  const lived = readLived(saves);
  const residents = withLived(readResidents(saves), lived);
  recordHistory(saves, analysis, residents, savedAt(saves));
  open = {
    stamp,
    label,
    savedAt: savedAt(saves).toISOString(),
    analysis,
    saves,
    residents,
    history: readHistory(saves),
    pulse: readPulse(saves),
    lived
  };
  // Decisions are made again on the land of the deployment the pull came from, with the client's map
  // files: in order by a run (runs.ts), and one at a time or over a stretch by the lab (lab/lab.ts).
  if (lived && clientDirectory) {
    const pull = join(saves, '../..');
    const landOfPull = async () => landOf(directory, await loadShard(directory, () => {}), pull, clientDirectory);
    const runs = new Runs(pull, landOfPull, () => open?.lab?.forget());
    open.runs = runs;
    open.lab = new Lab(pull, lived, runs, landOfPull);
  }
  console.log(`Read ${saves} in ${Math.round(performance.now() - started)} ms.`);
};
if (values.local) load(resolve(values.local), `Local save ${values.local}`);

// One pull at a time, in the background; its progress lines go to the page.
const pulling: { running: boolean; lines: string[]; error?: string } = { running: false, lines: [] };
function fetchPull() {
  if (pulling.running) return;
  Object.assign(pulling, { running: true, lines: [], error: undefined });
  // Sphere's rules do not matter to a pull, only where the shard is deployed.
  loadShard(directory, () => {})
    .then((config) =>
      pull(pullFrom(directory, config), directory, (line) => {
        pulling.lines.push(line);
        console.log(line);
      })
    )
    .catch((error) => {
      pulling.error = `Pull failed: ${error instanceof Error ? error.message : String(error)}`;
    })
    .finally(() => {
      pulling.running = false;
    });
}

const pullsResponse = (): PullsResponse => ({
  pulls: listPulls(directory).map((p) => ({ ...p, at: p.at.toISOString() })),
  pulling,
  open: open && { stamp: open.stamp, label: open.label, savedAt: open.savedAt }
});

// Client art never changes while the server runs.
const png = (bytes: Buffer | undefined) =>
  bytes
    ? new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }
      })
    : new Response('Not found', { status: 404 });
const notFound = (what: string) => Response.json({ error: `No ${what} here.` }, { status: 404 });
// A page of the open pull, or 409 when none is open (the app goes back to the pulls).
const page = (make: (o: Open) => Doc | undefined, what = 'page') => {
  if (!open) return Response.json({ error: 'No pull is open.' }, { status: 409 });
  const doc = make(open);
  return doc ? Response.json(doc) : notFound(what);
};

const hoursOf = (request: Request) => Number(new URL(request.url).searchParams.get('hours')) || undefined;
// Starting or stopping runs of the open pull's decisions (runs.ts).
const run = (act: (o: Open & { lived: NonNullable<Open['lived']> }, runs: Runs) => void) => {
  if (!open) return Response.json({ error: 'No pull is open.' }, { status: 409 });
  if (!open.lived || !open.runs)
    return Response.json({ error: 'Runs need a pull with history and the client’s files (--files).' }, { status: 409 });
  act(open as Open & { lived: NonNullable<Open['lived']> }, open.runs);
  return Response.json({ ok: true });
};
process.on('SIGINT', () => {
  open?.runs?.stopAll();
  process.exit(130);
});

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(values.port ?? 4100),
  idleTimeout: 0,
  routes: {
    '/api/pulls': {
      GET: () => Response.json(pullsResponse()),
      POST: () => {
        fetchPull();
        return Response.json(pullsResponse());
      }
    },
    '/api/pulls/:stamp': {
      DELETE: (request) => {
        const { stamp } = request.params;
        if (stamp === open?.stamp) return Response.json({ error: 'That pull is open.' }, { status: 409 });
        deletePull(stamp, directory);
        return Response.json(pullsResponse());
      }
    },
    '/api/pulls/:stamp/open': {
      POST: (request) => {
        const { stamp } = request.params;
        if (!isStamp(stamp)) return notFound('pull');
        try {
          if (open?.stamp !== stamp) load(savesOf(stamp, directory), `Pull ${stamp}`, stamp);
          return Response.json(pullsResponse());
        } catch (error) {
          return Response.json(
            { error: `Could not analyze ${stamp}: ${error instanceof Error ? error.message : String(error)}` },
            { status: 500 }
          );
        }
      }
    },
    '/api/page/overview': () =>
      page((o) => overviewDoc(o.analysis, o.residents, o.history, o.pulse, o.savedAt, Boolean(client), o.lived)),
    '/api/page/players': () => page((o) => playersDoc(o.analysis)),
    '/api/page/residents': () => page((o) => residentsDoc(o.analysis, o.residents)),
    '/api/page/trouble': () => page((o) => o.lived && livedTroubleDoc(o.lived)),
    '/api/page/loops': () => page((o) => o.lived && livedLoopsDoc(o.lived)),
    '/api/page/history': () => page((o) => historyDoc(o.history)),
    '/api/page/economy': () => page((o) => economyDoc(o.saves)),
    '/api/page/spent': () => page((o) => o.lived && livedSpentDoc(o.lived, o.saves)),
    '/api/page/minds': () => page((o) => mindsDoc(o.saves)),
    '/api/page/decisions': (request) => {
      const query = new URL(request.url).searchParams;
      const at = Math.max(0, Number(query.get('page')) || 0);
      const kind = query.get('kind') ?? undefined;
      return page((o) => o.lived && livedDecisionsDoc(o.lived, at, kind));
    },
    '/api/page/choices': (request) => page((o) => o.lived && choicesDoc(o.lived, o.runs, hoursOf(request))),
    '/api/page/choices/:resident': (request) => {
      const query = new URL(request.url).searchParams;
      return page(
        (o) =>
          o.lived &&
          residentChoicesDoc(
            o.lived,
            o.runs,
            request.params.resident,
            Math.max(0, Number(query.get('page')) || 0),
            hoursOf(request),
            query.get('only') ?? undefined
          ),
        'resident'
      );
    },
    '/api/page/choice/:id': (request) =>
      page((o) => o.lived && choiceDoc(o.lived, o.runs, Number(request.params.id)), 'decision'),
    '/api/runs/all': {
      POST: (request) =>
        run((o, runs) => {
          const { since, until } = spanOf(o.lived, hoursOf(request));
          for (const r of o.lived.residents.values()) runs.start(r.id, since, until);
        })
    },
    '/api/runs/stop': { POST: () => run((_, runs) => runs.stopAll()) },
    '/api/runs/:resident': {
      POST: (request) =>
        run((o, runs) => {
          const { since, until } = spanOf(o.lived, hoursOf(request));
          runs.start(request.params.resident, since, until);
        })
    },
    '/api/runs/:resident/stop': { POST: (request) => run((_, runs) => runs.stop(request.params.resident)) },
    ...labRoutes(() => open && { lived: open.lived, runs: open.runs, lab: open.lab }),
    '/api/page/search': (request) => {
      const query = new URL(request.url).searchParams.get('q') ?? '';
      return page((o) => searchDoc(o.analysis, query, search(o.analysis, query), client));
    },
    '/api/page/trace/:resident': (request) => {
      const query = new URL(request.url).searchParams;
      return page((o) =>
        traceDoc(
          o.saves,
          request.params.resident,
          Math.max(0, Number(query.get('page')) || 0),
          query.get('kind') ?? undefined,
          Number(query.get('before')) || undefined
        )
      );
    },
    '/api/page/event/:id': (request) => page((o) => eventDoc(o.saves, Number(request.params.id)), 'event'),
    // Weighed again inside the deployed AI service, where its history and world are.
    '/api/page/simulate/:id': async (request) => {
      try {
        const config = await loadShard(directory, () => {});
        const report = await simulateDecision(directory, config, Number(request.params.id));
        return Response.json(simulationDoc(report as Parameters<typeof simulationDoc>[0]));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    },
    '/api/page/replay/:serial': (request) =>
      page((o) => {
        const serial = Number(request.params.serial);
        const lived = o.lived && [...o.lived.residents.values()].find((r) => r.serial === serial);
        return lived && traceDoc(o.saves, lived.id, 0);
      }, 'resident'),
    '/api/page/mobile/:serial': (request) =>
      page((o) => {
        const m = o.analysis.world.mobiles.get(Number(request.params.serial));
        return m && mobileDoc(o.analysis, m, client);
      }, 'mobile'),
    '/api/page/item/:serial': (request) =>
      page((o) => {
        const i = o.analysis.world.items.get(Number(request.params.serial));
        return i && itemDoc(o.analysis, i, client);
      }, 'item'),
    '/api/map/:map': (request) => {
      if (!open) return Response.json({ error: 'No pull is open.' }, { status: 409 });
      const data = mapData(open.analysis, Number(request.params.map), open.lived);
      return data ? Response.json({ ...data, drawn: Boolean(client) }) : notFound('facet');
    },
    '/maptile/:map/:level/:tx/:ty': (request) => {
      const { map, level, tx, ty } = request.params;
      return png(client?.mapTile(Number(map), Number(level), Number(tx), Number(ty)));
    },
    '/gump/:id': (request) => {
      const query = new URL(request.url).searchParams;
      return png(client?.gump(Number(request.params.id), Number(query.get('hue') ?? 0), query.has('partial')));
    },
    '/art/:graphic': (request) => {
      const hue = Number(new URL(request.url).searchParams.get('hue') ?? 0);
      return png(client?.item(Number(request.params.graphic), hue));
    },
    '/radar/:map/:x/:y': (request) => {
      const { map, x, y } = request.params;
      const size = Math.min(1024, Number(new URL(request.url).searchParams.get('size') ?? 128));
      return png(client?.radar(Number(map), Number(x), Number(y), size));
    },
    // Every other path is the app, which routes in the browser.
    '/*': app
  },
  development: process.env.NODE_ENV !== 'production'
});
console.log(`Save browser: http://${server.hostname}:${server.port}/`);
