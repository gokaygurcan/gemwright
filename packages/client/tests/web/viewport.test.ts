import { expect, test } from 'bun:test';

import { createViewport } from '../../web/viewport';

test('logout restores login size and ignores pending game resizes until the next game', async () => {
  const canvas = { style: { width: '', height: '' } };
  const sizes: number[][] = [];
  let finish: (() => void) | undefined;
  let delayed = false;
  const runtime = {
    async getAssemblyExports() {
      return {
        ClassicUO: {
          Wasm: {
            WasmViewport: {
              async ResizeGame(width: number, height: number) {
                sizes.push([width, height]);
                if (delayed)
                  await new Promise<void>((resolve) => {
                    finish = resolve;
                  });
              }
            }
          }
        }
      };
    }
  };
  const viewport = createViewport(
    canvas,
    () => runtime,
    () => ({ width: 1440, height: 900 })
  );
  await viewport.game();
  expect(canvas.style).toEqual({ width: '1440px', height: '900px' });
  delayed = true;
  const pending = viewport.resize();
  await Promise.resolve();
  viewport.login();
  finish?.();
  await pending;
  await viewport.resize();
  expect(canvas.style).toEqual({ width: '640px', height: '480px' });
  expect(sizes).toHaveLength(2);
  delayed = false;
  await viewport.game();
  expect(canvas.style).toEqual({ width: '1440px', height: '900px' });
});

test('logout cancels a resize still waiting for the runtime exports', async () => {
  const canvas = { style: { width: '', height: '' } };
  let resizeCalls = 0;
  const exports = {
    ClassicUO: {
      Wasm: {
        WasmViewport: {
          async ResizeGame() {
            resizeCalls++;
          }
        }
      }
    }
  };
  const pending = Promise.withResolvers<typeof exports>();
  const viewport = createViewport(
    canvas,
    () => ({ getAssemblyExports: () => pending.promise }),
    () => ({ width: 1440, height: 900 })
  );
  const resizing = viewport.game();
  viewport.login();
  pending.resolve(exports);
  await resizing;
  expect(resizeCalls).toBe(0);
  expect(canvas.style).toEqual({ width: '640px', height: '480px' });
});
