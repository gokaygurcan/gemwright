import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type Analysis, analyze } from './analysis';
import { findClientFiles } from './client';
import { homePage, itemPage, layout, mobilePage, searchPage, status } from './pages';
import { pullLatest, savedAt } from './pulls';
import { search } from './search';

// A local website over a shard's world save: search characters, mobiles and items by name, type
// or serial, and open a page for each. Run from the shard folder, it pulls the deployment's
// latest save at start and on Refresh; --local reads a Saves folder already on disk instead.
//   bun packages/analyze/src/serve.ts [--local <Saves folder>] [--files <client files>] [--port 4100]
// With the game client's files (--files, else the repository's files/), character pages draw the
// character with the client's own art.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { local: { type: 'string' }, port: { type: 'string' }, files: { type: 'string' } }
});
status.live = !values.local;
const client = findClientFiles(values.files);
if (!client) console.log('No client files found: character pages show tables only (pass --files).');

const load = (saves: string): Analysis => {
  const started = performance.now();
  const loaded = analyze(saves);
  status.savedAt = savedAt(saves);
  console.log(`Read ${saves} in ${Math.round(performance.now() - started)} ms.`);
  return loaded;
};
let analysis = load(values.local ? resolve(values.local) : await pullLatest());

// One pull at a time; pages keep showing the previous save until the new one is read.
async function refresh() {
  if (status.refreshing) return;
  status.refreshing = true;
  status.error = undefined;
  try {
    analysis = load(await pullLatest());
  } catch (error) {
    status.error = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    status.refreshing = false;
  }
}

// Client art never changes while the server runs.
const png = (bytes: Buffer | undefined) =>
  bytes
    ? new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }
      })
    : new Response('Not found', { status: 404 });
const html = (body: string, code = 200) =>
  new Response(body, { status: code, headers: { 'content-type': 'text/html; charset=utf-8' } });
const missing = (what: string) =>
  html(layout('Not found', `<h1>Not found</h1><p>No ${what} with that serial.</p>`), 404);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(values.port ?? 4100),
  // A pull downloads the whole Saves folder; the refresh request waits for it.
  idleTimeout: 0,
  routes: {
    '/': () => html(homePage(analysis)),
    '/refresh': {
      POST: async (request) => {
        if (status.live) await refresh();
        return Response.redirect(request.headers.get('referer') ?? '/', 303);
      }
    },
    '/search': (request) => {
      const query = new URL(request.url).searchParams.get('q') ?? '';
      const hits = search(analysis, query);
      // A serial that matches exactly one thing opens it directly.
      const only = hits.length === 1 ? hits[0] : undefined;
      if (only && /^(0x[0-9a-f]+|\d+)$/i.test(query.trim()))
        return Response.redirect(`/${only.kind === 'item' ? 'item' : 'mobile'}/${only.serial}`, 302);
      return html(searchPage(query, hits));
    },
    '/mobile/:serial': (request) => {
      const m = analysis.world.mobiles.get(Number(request.params.serial));
      return m ? html(mobilePage(analysis, m, client)) : missing('mobile');
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
    '/item/:serial': (request) => {
      const i = analysis.world.items.get(Number(request.params.serial));
      return i ? html(itemPage(analysis, i)) : missing('item');
    }
  },
  fetch: () => missing('page')
});
console.log(`Save browser: http://${server.hostname}:${server.port}/`);
