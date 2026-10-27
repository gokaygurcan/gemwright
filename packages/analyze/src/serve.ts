import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { pull } from 'gemwright/src/pull';

import app from '../web/index.html';
import { type Analysis, analyze } from './analysis';
import { findClientFiles } from './client';
import { decisionsDoc } from './decisions';
import type { Doc } from './doc';
import { economyDoc } from './economy';
import { historyDoc, readHistory, recordHistory } from './history';
import { loopsDoc } from './loops';
import { itemDoc, mobileDoc, overviewDoc, searchDoc } from './pages';
import { playersDoc } from './players';
import { deletePull, isStamp, listPulls, savesOf } from './pull-store';
import { savedAt } from './pulls';
import type { PullsResponse } from './pulls-api';
import { replayDoc } from './replay';
import { readResidents, residentsDoc } from './residents';
import { search } from './search';
import { readLasting, troubleDoc } from './trouble';

// A local website over a shard's pulls (web/: a Preact app Bun bundles on the fly). Run from the
// shard folder, it opens on the list of pulls (.gemwright/pulls): fetch a new one from the
// deployment, delete one, or analyze one to search its characters, mobiles and items by name, type
// or serial. --local analyzes a Saves folder already on disk instead.
//   bun packages/analyze/src/serve.ts [--local <Saves folder>] [--files <client files>] [--port 4100]
// With the game client's files (--files, else the repository's files/), character pages draw the
// character with the client's own art.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    local: { type: 'string' },
    port: { type: 'string' },
    files: { type: 'string' }
  }
});
const client = findClientFiles(values.files);
if (!client) console.log('No client files found: character pages show tables only (pass --files).');
const directory = process.cwd();

// The pull being analyzed, and what the pages read from it.
interface Open {
  stamp?: string;
  label: string;
  savedAt: string;
  analysis: Analysis;
  saves: string;
  lasting: ReturnType<typeof readLasting>;
  residents: ReturnType<typeof readResidents>;
  history: ReturnType<typeof readHistory>;
}
let open: Open | undefined;
const load = (saves: string, label: string, stamp?: string) => {
  const started = performance.now();
  const analysis = analyze(saves);
  const residents = readResidents(saves);
  recordHistory(saves, analysis, residents, savedAt(saves));
  open = {
    stamp,
    label,
    savedAt: savedAt(saves).toISOString(),
    analysis,
    saves,
    lasting: readLasting(saves),
    residents,
    history: readHistory(saves)
  };
  console.log(`Read ${saves} in ${Math.round(performance.now() - started)} ms.`);
};
if (values.local) load(resolve(values.local), `Local save ${values.local}`);

// One pull at a time, in the background; its progress lines go to the page.
const pulling: { running: boolean; lines: string[]; error?: string } = { running: false, lines: [] };
function fetchPull() {
  if (pulling.running) return;
  Object.assign(pulling, { running: true, lines: [], error: undefined });
  const log = console.log;
  console.log = (...args: unknown[]) => {
    pulling.lines.push(args.map(String).join(' '));
    log(...args);
  };
  pull({}, directory)
    .catch((error) => {
      pulling.error = `Pull failed: ${error instanceof Error ? error.message : String(error)}`;
    })
    .finally(() => {
      console.log = log;
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
    '/api/page/overview': () => page((o) => overviewDoc(o.analysis)),
    '/api/page/players': () => page((o) => playersDoc(o.analysis)),
    '/api/page/residents': () => page((o) => residentsDoc(o.analysis, o.residents)),
    '/api/page/trouble': () => page((o) => troubleDoc(o.lasting)),
    '/api/page/loops': () => page((o) => loopsDoc(o.lasting)),
    '/api/page/history': () => page((o) => historyDoc(o.history)),
    '/api/page/economy': () => page((o) => economyDoc(o.saves)),
    '/api/page/decisions': () => page((o) => decisionsDoc(o.saves)),
    '/api/page/search': (request) => {
      const query = new URL(request.url).searchParams.get('q') ?? '';
      return page((o) => searchDoc(query, search(o.analysis, query)));
    },
    '/api/page/replay/:serial': (request) => page((o) => replayDoc(o.saves, Number(request.params.serial)), 'resident'),
    '/api/page/mobile/:serial': (request) =>
      page((o) => {
        const m = o.analysis.world.mobiles.get(Number(request.params.serial));
        return m && mobileDoc(o.analysis, m, client);
      }, 'mobile'),
    '/api/page/item/:serial': (request) =>
      page((o) => {
        const i = o.analysis.world.items.get(Number(request.params.serial));
        return i && itemDoc(o.analysis, i);
      }, 'item'),
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
