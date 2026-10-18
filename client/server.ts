import { realpath, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';

import { parseManifest } from './files';
import { Huffman } from './huffman';

export interface ClientConfig {
  host: string;
  port: number;
  name: string;
  version: string;
  encryption: number;
  publicOrigin?: string;
  bundle: string;
  assets: string;
  listenPort: number;
}

function port(value: string, name: string, allowZero = false): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 65535)
    throw new Error(`${name} must be a valid port.`);
  return number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  const host = env.UO_HOST?.trim();
  if (!host || /[\s/?#@]/.test(host)) throw new Error('UO_HOST must name the shard reachable by this service.');
  const version = env.UO_CLIENT_VERSION ?? '7.0.45.1';
  if (!/^\d{1,2}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version))
    throw new Error('UO_CLIENT_VERSION must have four numeric parts.');
  const encryption = Number(env.UO_ENCRYPTION ?? '0');
  if (!Number.isInteger(encryption) || encryption < 0 || encryption > 5) throw new Error('UO_ENCRYPTION must be 0–5.');
  let publicOrigin: string | undefined;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path.');
    publicOrigin = url.origin;
  }
  if (env.RAILWAY_ENVIRONMENT_ID && !publicOrigin)
    throw new Error('PUBLIC_ORIGIN is required on Railway (https://your-public-domain).');
  if (!env.GAMEFILES_PATH?.trim()) throw new Error('GAMEFILES_PATH must point to your game-file directory.');
  return {
    host,
    port: port(env.UO_PORT ?? '2593', 'UO_PORT'),
    name: env.SERVER_NAME ?? 'Gemwright',
    version,
    encryption,
    publicOrigin,
    bundle: resolve(env.CLIENT_BUNDLE_PATH ?? fileURLToPath(new URL('./bundle/public', import.meta.url))),
    assets: resolve(env.GAMEFILES_PATH),
    listenPort: port(env.PORT ?? '3000', 'PORT', true)
  };
}

interface Connection {
  tcp?: Socket;
  huffman?: Huffman;
  ended?: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
}
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff'
};
const maxBuffer = 1024 * 1024;

async function staticFile(root: string, name: string, request: Request): Promise<Response> {
  try {
    const base = await realpath(root);
    const path = await realpath(resolve(base, name));
    if (!path.startsWith(base + sep) || !(await stat(path)).isFile()) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
    const brotli = request.headers
      .get('accept-encoding')
      ?.split(',')
      .some((value) => {
        const [encoding, ...parameters] = value.trim().split(';');
        const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
        return encoding === 'br' && (!quality || Number(quality.trim().slice(2)) > 0);
      });
    if (brotli && !request.headers.has('range')) {
      try {
        const compressed = await realpath(`${path}.br`);
        const original = await stat(path),
          packed = await stat(compressed);
        if (compressed.startsWith(base + sep) && packed.isFile() && packed.mtimeMs >= original.mtimeMs) {
          headers.set('Content-Type', Bun.file(path).type);
          headers.set('Content-Encoding', 'br');
          return new Response(Bun.file(compressed), { headers });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return new Response(Bun.file(path), { headers });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return new Response('Not found', { status: 404 });
    throw error;
  }
}

export function startClient(config: ClientConfig) {
  const connections = new Set<ServerWebSocket<Connection>>();
  function finish(ws: ServerWebSocket<Connection>) {
    // The browser's .NET transport needs a chance to consume the final relay frame before the close frame.
    ws.data.closeTimer ??= setTimeout(() => ws.close(1000, 'Shard connection ended'), 300);
  }
  let assetIndex: { modified: number; paths: Map<string, string> } | undefined;
  async function assetPath(name: string) {
    if (name === 'manifest.json') return name;
    const manifest = Bun.file(resolve(config.assets, 'manifest.json'));
    try {
      if (!assetIndex || assetIndex.modified !== manifest.lastModified) {
        const files = parseManifest(await manifest.json());
        assetIndex = {
          modified: manifest.lastModified,
          paths: new Map(files.map((file) => [file.path.toLowerCase(), file.path]))
        };
      }
      return assetIndex.paths.get(name.toLowerCase());
    } catch {
      return undefined;
    }
  }
  const server = Bun.serve<Connection>({
    hostname: '::',
    port: config.listenPort,
    async fetch(request, server) {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname === '/livez') {
        response = Response.json({ running: true });
      } else if (url.pathname === '/healthz') {
        const ready =
          (await Bun.file(resolve(config.bundle, 'index.html')).exists()) &&
          (await Bun.file(resolve(config.bundle, '_framework/dotnet.js')).exists()) &&
          (await Bun.file(resolve(config.assets, 'manifest.json')).exists());
        response = Response.json({ ready }, { status: ready ? 200 : 503 });
      } else if (
        config.publicOrigin &&
        (request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1)) !== 'https'
      ) {
        response = Response.redirect(config.publicOrigin + url.pathname + url.search, 308);
      } else if (url.pathname === '/ws') {
        const origin = request.headers.get('origin');
        const expected = config.publicOrigin ?? url.origin;
        if (origin !== expected) response = new Response('Forbidden origin', { status: 403 });
        else if (server.upgrade(request, { data: {} })) return;
        else response = new Response('WebSocket upgrade required', { status: 426 });
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        response = new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      } else if (url.pathname === '/api/config') {
        response = Response.json(
          {
            name: config.name,
            clientVersion: config.version,
            encryption: config.encryption,
            websocketPath: '/ws',
            gamefilesPath: '/gamefiles/'
          },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      } else {
        let path: string;
        try {
          path = decodeURIComponent(url.pathname);
        } catch {
          return new Response('Invalid path', { status: 400, headers: isolation });
        }
        if (
          path.includes('\0') ||
          path.includes('\\') ||
          path.split('/').some((part) => part.startsWith('.') && part !== '')
        ) {
          response = new Response('Not found', { status: 404 });
        } else if (path.startsWith('/gamefiles/')) {
          const name = await assetPath(path.slice('/gamefiles/'.length));
          response = name ? await staticFile(config.assets, name, request) : new Response('Not found', { status: 404 });
        } else {
          response = await staticFile(config.bundle, path === '/' ? 'index.html' : path.slice(1), request);
        }
      }
      for (const [name, value] of Object.entries(isolation)) response.headers.set(name, value);
      if (config.publicOrigin) response.headers.set('Strict-Transport-Security', 'max-age=31536000');
      return request.method === 'HEAD' ? new Response(null, response) : response;
    },
    websocket: {
      maxPayloadLength: 65536,
      backpressureLimit: maxBuffer,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: true,
      perMessageDeflate: false,
      open(ws) {
        connections.add(ws);
        const tcp = createConnection({ host: config.host, port: config.port });
        ws.data.tcp = tcp;
        tcp.setNoDelay(true);
        tcp.setTimeout(15000);
        tcp.once('connect', () => tcp.setTimeout(0));
        tcp.on('timeout', () => {
          tcp.destroy();
          ws.close(1011, 'Shard connection timed out');
        });
        tcp.on('data', (chunk: Buffer) => {
          try {
            // The upstream WASM build delegates Huffman decoding to the relay when encryption is off.
            for (let start = 0; start < chunk.length; start += 8192) {
              const encoded = chunk.subarray(start, start + 8192);
              const bytes = ws.data.huffman ? ws.data.huffman.decompress(encoded) : encoded;
              for (let offset = 0; offset < bytes.length; offset += 32768) {
                const result = ws.send(bytes.subarray(offset, offset + 32768));
                if (result === 0) {
                  tcp.destroy();
                  return;
                }
                if (result === -1) tcp.pause();
              }
            }
          } catch {
            ws.close(1011, 'Invalid shard stream');
            tcp.destroy();
          }
        });
        tcp.on('end', () => {
          // ClassicUO reconnects after the relay packet. Let the browser consume queued bytes before closing.
          ws.data.ended = true;
          if (ws.getBufferedAmount() === 0) finish(ws);
        });
        tcp.on('error', () => ws.close(1011, 'Shard connection failed'));
        tcp.on('close', () => {
          if (!ws.data.ended) ws.close(1011, 'Shard connection closed');
        });
      },
      message(ws, message) {
        if (typeof message === 'string') {
          ws.close(1003, 'Binary protocol required');
          return;
        }
        const tcp = ws.data.tcp;
        if (!tcp || tcp.destroyed) {
          ws.close(1011, 'Shard unavailable');
          return;
        }
        // node:net queues writes during connect; cap that queue as well as slow upstream writes.
        if (tcp.writableLength + message.byteLength > maxBuffer) {
          ws.close(1009, 'Send buffer exceeded');
          return;
        }
        if (
          config.encryption === 0 &&
          !ws.data.huffman &&
          ((message.byteLength === 65 && message[0] === 0x91) || (message.byteLength === 69 && message[4] === 0x91))
        )
          ws.data.huffman = new Huffman();
        tcp.write(message);
      },
      drain(ws) {
        if (ws.data.ended) finish(ws);
        else ws.data.tcp?.resume();
      },
      close(ws) {
        connections.delete(ws);
        clearTimeout(ws.data.closeTimer);
        ws.data.tcp?.destroy();
      }
    }
  });
  return {
    server,
    async stop() {
      for (const ws of connections) {
        ws.data.tcp?.destroy();
        ws.close(1001, 'Service stopping');
      }
      await server.stop(true);
    }
  };
}

if (import.meta.main) {
  const app = startClient(loadConfig());
  console.log(`ClassicUO web service listening on ${app.server.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.stop();
    });
}
