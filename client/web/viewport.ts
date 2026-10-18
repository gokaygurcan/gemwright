import type { Runtime } from './types';

export function createViewport(
  canvas: { style: { width: string; height: string } },
  runtime: () => Pick<Runtime, 'getAssemblyExports'> | undefined,
  size: () => { width: number; height: number }
) {
  let gameActive = false;
  let revision = 0;
  function login() {
    gameActive = false;
    revision++;
    // LoginScene resets the backing store itself; discard the previous world's CSS size.
    canvas.style.width = '640px';
    canvas.style.height = '480px';
  }
  async function resize() {
    const current = runtime();
    if (!gameActive || !current) return;
    const request = ++revision;
    const available = size();
    const width = Math.max(640, available.width);
    const height = Math.max(480, available.height);
    const exports = await current.getAssemblyExports('classicuo-wasm');
    if (!gameActive || request !== revision) return;
    await exports.ClassicUO.Wasm.WasmViewport.ResizeGame(width, height);
    if (!gameActive || request !== revision) return;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  return {
    login,
    resize,
    game() {
      gameActive = true;
      return resize();
    }
  };
}
