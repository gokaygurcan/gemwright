import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

import { loadConfig, startClient } from '../../client/server';

// DOM types omit Bun's client-side header option.
const ClientWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function entry(path: string, contents: string) {
  return { path, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') };
}

function exchange(url: string, sent?: Uint8Array, closeAfterBytes?: number) {
  const ws = new ClientWebSocket(`${url.replace('http:', 'ws:')}/ws`, { headers: { Origin: url } });
  ws.binaryType = 'arraybuffer';
  return new Promise<{ bytes: Buffer; code: number; frameSizes: number[] }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    ws.onopen = () => {
      if (sent) ws.send(new Uint8Array(sent));
    };
    ws.onmessage = (event) => {
      const bytes = Buffer.from(event.data);
      chunks.push(bytes);
      received += bytes.length;
      if (closeAfterBytes && received >= closeAfterBytes) ws.close(1000);
    };
    ws.onclose = (event) =>
      resolve({ bytes: Buffer.concat(chunks), code: event.code, frameSizes: chunks.map((chunk) => chunk.length) });
    ws.onerror = reject;
  });
}

async function fixture(publicOrigin?: string, encryption = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-web-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'bundle/_framework'), { recursive: true });
  await mkdir(join(directory, 'gamefiles'));
  await writeFile(join(directory, 'bundle/index.html'), '<canvas id="canvas"></canvas>');
  await writeFile(join(directory, 'bundle/_framework/dotnet.js'), 'export const dotnet = {};');
  await writeFile(join(directory, 'gamefiles/Art.mul'), 'art');
  await writeFile(join(directory, 'gamefiles/manifest.json'), JSON.stringify({ files: [entry('Art.mul', 'art')] }));
  const sockets = new Set<Socket>();
  const tcp = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => socket.write(data));
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        tcp.close(() => resolve());
      })
  );
  const address = tcp.address() as { port: number };
  const config = loadConfig({
    UO_HOST: '127.0.0.1',
    UO_ENCRYPTION: String(encryption),
    UO_PORT: String(address.port),
    PORT: '0',
    CLIENT_BUNDLE_PATH: join(directory, 'bundle'),
    GAMEFILES_PATH: join(directory, 'gamefiles'),
    PUBLIC_ORIGIN: publicOrigin
  });
  const app = startClient(config);
  cleanup.push(() => app.stop());
  return { ...app, directory, url: `http://localhost:${app.server.port}`, tcp };
}

test('starts before Railway populates the game-file volume', async () => {
  const app = await fixture('https://play.example.com');
  await rm(join(app.directory, 'gamefiles/manifest.json'));
  expect((await fetch(`${app.url}/livez`)).status).toBe(200);
  expect((await fetch(`${app.url}/healthz`)).status).toBe(503);
  await writeFile(join(app.directory, 'gamefiles/manifest.json'), JSON.stringify({ files: [entry('Art.mul', 'art')] }));
  await rm(join(app.directory, 'bundle/_framework/dotnet.js'));
  expect((await fetch(`${app.url}/healthz`)).status).toBe(503);
});

test('serves the client with isolation headers and private shard config', async () => {
  const app = await fixture();
  const response = await fetch(app.url);
  expect(await response.text()).toContain('<canvas');
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  const config = (await fetch(`${app.url}/api/config`).then((r) => r.json())) as {
    websocketPath: string;
    host?: string;
  };
  expect(config.websocketPath).toBe('/ws');
  expect(config.host).toBeUndefined();
  expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
  expect(await fetch(`${app.url}/gamefiles/art.mul`).then((response) => response.text())).toBe('art');
});

test('redirects HTTP using the configured origin and allows Railway health checks', async () => {
  const app = await fixture('https://play.example.com');
  const response = await fetch(`${app.url}/?hello=world`, { redirect: 'manual' });
  expect(response.status).toBe(308);
  expect(response.headers.get('location')).toBe('https://play.example.com/?hello=world');
  expect((await fetch(app.url, { headers: { 'x-forwarded-proto': 'https' } })).status).toBe(200);
});

test('rejects unknown resources, malformed paths and symlinks outside asset roots', async () => {
  const app = await fixture();
  await writeFile(join(app.directory, 'secret'), 'secret');
  await symlink(join(app.directory, 'secret'), join(app.directory, 'gamefiles/leak.mul'));
  await symlink(join(app.directory, 'secret'), join(app.directory, 'bundle/leak.js'));
  await writeFile(
    join(app.directory, 'gamefiles/manifest.json'),
    JSON.stringify({ files: [entry('leak.mul', 'secret')] })
  );
  for (const path of ['/gamefiles/leak.mul', '/leak.js', '/missing.wasm', '/.env', '/gamefiles/%2e%2e%2fsecret'])
    expect((await fetch(app.url + path)).status).toBe(404);
  expect((await fetch(`${app.url}/%zz`)).status).toBe(400);
});

test('relays bytes unchanged through separate login and game connections', async () => {
  const app = await fixture();
  for (const bytes of [new Uint8Array([0xef, 0, 1, 255]), new Uint8Array([0x91, 2, 0x8c, 5])]) {
    const response = await exchange(app.url, bytes, bytes.length);
    expect(response.bytes).toEqual(Buffer.from(bytes));
  }
});

test('rejects cross-origin websocket upgrades', async () => {
  const app = await fixture();
  const response = await fetch(`${app.url}/ws`, { headers: { Origin: 'https://other.example' } });
  expect(response.status).toBe(403);
  expect((await fetch(`${app.url}/ws`, { headers: { Origin: app.url } })).status).toBe(426);
});

test('requires a shard and validates production configuration', () => {
  expect(() => loadConfig({})).toThrow('UO_HOST');
  expect(() => loadConfig({ UO_HOST: 'shard', RAILWAY_ENVIRONMENT_ID: 'production' })).toThrow('PUBLIC_ORIGIN');
  expect(() => loadConfig({ UO_HOST: 'shard', PUBLIC_ORIGIN: 'http://example.com' })).toThrow('HTTPS');
  expect(() => loadConfig({ UO_HOST: 'shard' })).toThrow('GAMEFILES_PATH');
  expect(() => loadConfig({ UO_HOST: 'shard', UO_PORT: '2593junk', GAMEFILES_PATH: '/external/uo' })).toThrow('port');
});

test('delivers all final bytes in bounded frames before closing', async () => {
  const app = await fixture();
  app.tcp.removeAllListeners('connection');
  const bytes = Buffer.alloc(100000, 0x8c);
  app.tcp.on('connection', (socket) => socket.end(bytes));
  const response = await exchange(app.url);
  expect(response.bytes).toEqual(bytes);
  expect(response.code).toBe(1000);
  expect(response.frameSizes.every((size) => size <= 32768)).toBe(true);
});

test('negotiates precompressed files without changing decoded runtime bytes', async () => {
  const app = await fixture();
  const compressed = join(app.directory, 'bundle/_framework/dotnet.js.br');
  await writeFile(compressed, brotliCompressSync('export const dotnet = {};'));
  const packed = await fetch(`${app.url}/_framework/dotnet.js`, { headers: { 'Accept-Encoding': 'br' } });
  expect(packed.headers.get('content-encoding')).toBe('br');
  expect(packed.headers.get('content-type')).toContain('javascript');
  expect(await packed.text()).toBe('export const dotnet = {};');
  const plain = await fetch(`${app.url}/_framework/dotnet.js`, { headers: { 'Accept-Encoding': 'br;q=0, identity' } });
  expect(plain.headers.get('content-encoding')).toBeNull();
  expect(await plain.text()).toBe('export const dotnet = {};');
  await utimes(compressed, 0, 0);
  const stale = await fetch(`${app.url}/_framework/dotnet.js`, { headers: { 'Accept-Encoding': 'br' } });
  expect(stale.headers.get('content-encoding')).toBeNull();
  expect(await stale.text()).toBe('export const dotnet = {};');
});

test('decodes game traffic only for the upstream runtime’s unencrypted mode', async () => {
  for (const encryption of [0, 5]) {
    const app = await fixture(undefined, encryption);
    app.tcp.removeAllListeners('connection');
    app.tcp.on('connection', (socket) =>
      socket.once('data', () => {
        socket.write(Buffer.from('76', 'hex'));
        setTimeout(() => socket.end(Buffer.from('fe80', 'hex')), 5);
      })
    );
    const login = Buffer.alloc(69);
    login[4] = 0x91;
    const response = await exchange(app.url, login);
    expect(response.bytes).toEqual(Buffer.from(encryption === 0 ? '7301' : '76fe80', 'hex'));
  }
});
