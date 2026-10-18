import { parseManifest, runtimeFiles } from '../files';
import { prepareAssets, restoreProfiles } from './assets';
import { installAudio } from './audio';
import { installInput } from './input';
import type { NativeModule, Runtime, RuntimeBuilder } from './types';
import { createViewport } from './viewport';

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing client host element: ${selector}`);
  return node;
}
const canvas = element<HTMLCanvasElement>('#canvas');
const loading = element<HTMLElement>('#loading');
const status = element<HTMLElement>('#status');
const detail = element<HTMLElement>('#detail');
const progress = element<HTMLProgressElement>('#progress');
const retry = element<HTMLButtonElement>('#retry');
let native: NativeModule | undefined;
let runtime: Runtime | undefined;
let ready = false;
let failed = false;
const viewport = createViewport(
  canvas,
  () => runtime,
  () => ({ width: innerWidth, height: innerHeight })
);
let loginSeen = false;
let watching = false;
retry.addEventListener('click', () => location.reload());
function fail(error: unknown) {
  if (failed) return;
  failed = true;
  ready = false;
  canvas.classList.remove('game-ready');
  loading.hidden = false;
  progress.hidden = true;
  retry.hidden = false;
  status.textContent = 'ClassicUO could not start';
  detail.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}
function update(message: string, completed?: number, total?: number) {
  if (failed) return;
  status.textContent = message;
  if (total) {
    progress.max = total;
    progress.value = completed ?? 0;
  } else progress.removeAttribute('value');
}
async function getJson(path: string) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
  return response.json();
}
function reveal() {
  if (failed || ready || document.hidden) return;
  ready = true;
  canvas.classList.add('game-ready');
  loading.hidden = true;
  canvas.focus();
}
function watchLoginFrames() {
  if (watching || ready || failed) return;
  watching = true;
  let quiet = 0,
    last = performance.now();
  function frame(now: number) {
    if (ready || failed) {
      watching = false;
      return;
    }
    quiet = !document.hidden && now - last < 60 ? quiet + 1 : 0;
    last = now;
    if (quiet >= 30) {
      reveal();
      watching = false;
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function wireCanvasTransfer() {
  const original = Worker.prototype.postMessage;
  let transferred = false;
  // The published SDL library expects the deputy worker's startup message to carry the canvas.
  Worker.prototype.postMessage = function (message, options) {
    if (!transferred && message?.cmd === 'run' && message.moduleCanvasId === 'canvas') {
      transferred = true;
      if (!message.offscreenCanvases?.canvas) {
        const offscreen = canvas.transferControlToOffscreen();
        message.offscreenCanvases = {
          ...message.offscreenCanvases,
          canvas: { offscreenCanvas: offscreen, id: 'canvas', canvasSharedPtr: 0 }
        };
        const transfer = Array.isArray(options) ? options : (options?.transfer ?? []);
        return original.call(this, message, { transfer: [...transfer, offscreen] });
      }
    }
    return original.call(this, message, Array.isArray(options) ? { transfer: options } : options);
  };
}

async function boot() {
  if (!isSecureContext || !crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
    throw new Error('ClassicUO requires HTTPS and cross-origin isolation. Check the web service headers.');
  if (!navigator.storage?.getDirectory || !HTMLCanvasElement.prototype.transferControlToOffscreen)
    throw new Error(
      'This browser does not support the storage and canvas features required by ClassicUO. Use a current desktop Chrome or Edge.'
    );
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2');
  if (!gl) throw new Error('WebGL 2 is unavailable. Enable hardware acceleration in your browser.');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  const config = await getJson('/api/config');
  document.title = config.name;
  const files = runtimeFiles(parseManifest(await getJson('/gamefiles/manifest.json')));
  const mount = await prepareAssets(files, update);
  update('Starting ClassicUO');
  window.addEventListener(
    'resize',
    () => {
      void viewport.resize().catch(fail);
    },
    true
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden && loginSeen) watchLoginFrames();
    },
    true
  );
  installAudio(() => native);
  installInput(
    canvas,
    () => native,
    () => ready
  );
  wireCanvasTransfer();
  Object.assign(globalThis, {
    __uo_signal(signal: string) {
      if (signal === 'login-gump-added') {
        viewport.login();
        loginSeen = true;
        update('Preparing login screen');
        watchLoginFrames();
      }
      if (signal === 'draw-heartbeat' && loginSeen) reveal();
      if (signal === 'gamescene-active' || signal === 'player-created') {
        reveal();
        void viewport.game().catch(fail);
      }
    }
  });
  const endpoint = new URL('/ws', location.origin);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Keep the loader as a separate runtime import; the SDK produces this file during WASM publish.
  const runtimePath = '/_framework/dotnet.js';
  const { dotnet } = (await import(runtimePath)) as { dotnet: RuntimeBuilder };
  const startupTimer = setTimeout(() => fail(new Error('The client runtime did not start. Reload to retry.')), 120000);
  runtime = await dotnet
    .withModuleConfig({
      canvas,
      onAbort: fail,
      preRun: [
        (module) => {
          native = module;
          module.canvas = canvas;
        }
      ]
    })
    .withEnvironmentVariable('FNA_PLATFORM_BACKEND', 'SDL2')
    .withEnvironmentVariable('FNA3D_FORCE_DRIVER', 'OpenGL')
    .withEnvironmentVariable('WASM_UO_WS_URL', endpoint.href)
    .withEnvironmentVariable('WASM_UO_CLIENT_VERSION', config.clientVersion)
    .withEnvironmentVariable('WASM_UO_ENCRYPTION', String(config.encryption))
    .withEnvironmentVariable('CUO_HTTP_ORIGIN', location.origin)
    .withEnvironmentVariable('CUO_SHARD_BASE', 'gamefiles')
    .withEnvironmentVariable('CUO_SNAPSHOT_MODE', 'off')
    .create()
    .finally(() => clearTimeout(startupTimer));
  if (failed) return;
  if (!native) throw new Error('The WASM runtime did not expose its filesystem.');
  await restoreProfiles(native.FS);
  await mount(native.FS);
  let syncing = false;
  const flush = () => {
    if (!native || syncing || failed) return;
    syncing = true;
    native.FS.syncfs(false, (error) => {
      syncing = false;
      if (error) console.error('Profile save failed', error);
    });
  };
  Object.assign(globalThis, { __wasm_flush_idbfs: flush });
  setInterval(flush, 10000);
  window.addEventListener('pagehide', flush);
  update('Opening login screen');
  setTimeout(() => {
    if (!ready) fail(new Error('ClassicUO did not finish drawing its login screen. Reload to retry.'));
  }, 120000);
  await runtime.runMain();
  if (!loginSeen && !ready)
    throw new Error(
      'ClassicUO exited before opening its login screen. Check the browser console for the runtime error.'
    );
}

window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));
void boot().catch(fail);
