import type { NativeModule } from './types';

const special: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  Delete: 127,
  CapsLock: 0x40000039,
  PrintScreen: 0x40000046,
  ScrollLock: 0x40000047,
  Pause: 0x40000048,
  Insert: 0x40000049,
  Home: 0x4000004a,
  PageUp: 0x4000004b,
  End: 0x4000004d,
  PageDown: 0x4000004e,
  ArrowRight: 0x4000004f,
  ArrowLeft: 0x40000050,
  ArrowDown: 0x40000051,
  ArrowUp: 0x40000052,
  NumLock: 0x40000053,
  ControlLeft: 0x400000e0,
  ShiftLeft: 0x400000e1,
  AltLeft: 0x400000e2,
  MetaLeft: 0x400000e3,
  ControlRight: 0x400000e4,
  ShiftRight: 0x400000e5,
  AltRight: 0x400000e6,
  MetaRight: 0x400000e7
};
const punctuation: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
};
for (let index = 1; index <= 12; index++) special[`F${index}`] = 0x40000039 + index;

export function installInput(canvas: HTMLCanvasElement, module: () => NativeModule | undefined, ready: () => boolean) {
  const keys = new Map<string, { key: number; scan: number }>();
  const buttons = new Set<number>();
  const modifiers = new Set<string>();
  let x = 0,
    y = 0;
  let textPointer = 0;
  let clipboard = '';
  const encoder = new TextEncoder();
  const owns = () => {
    const active = document.activeElement;
    return active === canvas || active === document.body || active === document.documentElement;
  };
  const stop = (event: Event) => event.stopImmediatePropagation();
  const text = (value: string) => {
    const native = module();
    if (!native) return;
    textPointer ||= native._malloc(64);
    // One code point per event also keeps multi-byte characters inside the native 64-byte text slot.
    for (const character of value) {
      const bytes = encoder.encode(character);
      native.HEAPU8.set(bytes, textPointer);
      native.HEAPU8[textPointer + bytes.length] = 0;
      native._wasm_push_text(textPointer);
    }
  };
  Object.assign(globalThis, {
    __wasm_clipboard_get: () => clipboard,
    __wasm_clipboard_set(value: string) {
      clipboard = value;
      void navigator.clipboard?.writeText(value).catch(() => {});
    }
  });
  window.addEventListener(
    'paste',
    (event) => {
      if (!owns() || !ready()) return;
      event.preventDefault();
      stop(event);
      clipboard = event.clipboardData?.getData('text/plain') ?? '';
      text(clipboard);
    },
    true
  );
  function key(event: KeyboardEvent, down: boolean) {
    if (!owns()) return;
    // SDL's DOM handlers synchronously proxy to the game thread. Our ring buffer must own these events.
    stop(event);
    if (!ready()) return;
    if (event.code === 'KeyV' && (event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const native = module();
    if (!native) return;
    if (down) modifiers.add(event.code);
    else modifiers.delete(event.code);
    const altGraph = event.getModifierState('AltGraph');
    const has = (name: string) => modifiers.has(`${name}Left`) || modifiers.has(`${name}Right`);
    const mod =
      (has('Shift') ? 1 : 0) |
      (!altGraph && has('Control') ? 64 : 0) |
      (!altGraph && has('Alt') ? 256 : 0) |
      (has('Meta') ? 1024 : 0) |
      (event.getModifierState('CapsLock') ? 8192 : 0);
    const symbol = punctuation[event.code];
    let code = special[event.code] ?? 0;
    if (/^Key[A-Z]$/.test(event.code)) code = event.key.toLowerCase().charCodeAt(0);
    else if (/^Digit\d$/.test(event.code)) code = event.code.charCodeAt(5);
    else if (symbol) code = symbol.charCodeAt(0);
    else if (!code && event.key.length === 1) code = event.key.charCodeAt(0);
    let scan = code >= 0x40000000 ? code & 0xffff : 0;
    if (/^Key[A-Z]$/.test(event.code)) scan = event.code.charCodeAt(3) - 65 + 4;
    else if (/^Digit\d$/.test(event.code)) scan = event.code === 'Digit0' ? 39 : Number(event.code.slice(5)) + 29;
    else
      scan =
        ({ Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44 } as Record<string, number>)[event.code] ?? scan;
    if (code) native._wasm_push_key(down ? 1 : 0, code, scan, mod, event.repeat ? 1 : 0);
    if (down) keys.set(event.code, { key: code, scan });
    else keys.delete(event.code);
    if (
      down &&
      !event.isComposing &&
      event.key.length === 1 &&
      (altGraph || (!has('Control') && !has('Alt') && !has('Meta')))
    )
      text(event.key);
  }
  window.addEventListener('keydown', (event) => key(event, true), true);
  window.addEventListener('keyup', (event) => key(event, false), true);
  canvas.addEventListener('compositionend', (event) => {
    if (ready()) text(event.data);
  });
  function position(event: PointerEvent | WheelEvent) {
    const rect = canvas.getBoundingClientRect();
    const nextX = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const nextY = ((event.clientY - rect.top) * canvas.height) / rect.height;
    const delta = { x: nextX - x, y: nextY - y };
    x = nextX;
    y = nextY;
    return delta;
  }
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel'] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target !== canvas && !buttons.size) return;
        stop(event);
        if (!ready()) return;
        const native = module();
        if (!native) return;
        const delta = position(event);
        if (type === 'pointermove') {
          const mask = (event.buttons & 1) | ((event.buttons & 2) << 1) | ((event.buttons & 4) >> 1);
          native._wasm_push_mouse_motion(x, y, delta.x, delta.y, mask);
        } else {
          const down = type === 'pointerdown';
          if (down) {
            buttons.add(event.button + 1);
            canvas.focus({ preventScroll: true });
          } else buttons.delete(event.button + 1);
          native._wasm_push_mouse_button(down ? 1 : 0, event.button + 1, x, y);
        }
        event.preventDefault();
      },
      { capture: true, passive: false }
    );
  }
  window.addEventListener(
    'wheel',
    (event) => {
      if (event.target !== canvas) return;
      stop(event);
      event.preventDefault();
      if (ready()) {
        position(event);
        module()?._wasm_push_mouse_wheel(-Math.sign(event.deltaX), -Math.sign(event.deltaY), x, y);
      }
    },
    { capture: true, passive: false }
  );
  // SDL also subscribes to compatibility mouse events synthesized after pointer events.
  for (const name of ['mousedown', 'mouseup', 'mousemove', 'contextmenu', 'auxclick']) {
    window.addEventListener(
      name,
      (event) => {
        if (event.target === canvas) {
          stop(event);
          event.preventDefault();
        }
      },
      { capture: true, passive: false }
    );
  }
  for (const type of ['pointerenter', 'pointerleave'] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target !== canvas) return;
        stop(event);
        if (ready()) module()?._wasm_push_mouse_in_window(type === 'pointerenter' ? 1 : 0);
      },
      true
    );
  }
  function release() {
    const native = module();
    if (ready() && native) {
      for (const { key, scan } of keys.values()) native._wasm_push_key(0, key, scan, 0, 0);
      for (const button of buttons) native._wasm_push_mouse_button(0, button, x, y);
      native._wasm_push_window_focus(0);
    }
    keys.clear();
    buttons.clear();
    modifiers.clear();
  }
  window.addEventListener(
    'blur',
    (event) => {
      release();
      stop(event);
    },
    true
  );
  window.addEventListener(
    'focus',
    (event) => {
      modifiers.clear();
      if (ready()) module()?._wasm_push_window_focus(1);
      stop(event);
    },
    true
  );
  document.addEventListener(
    'visibilitychange',
    (event) => {
      if (document.hidden) release();
      stop(event);
    },
    true
  );
  // Block SDL's synchronous resize proxy; the managed viewport bridge handles resizing asynchronously.
  window.addEventListener('resize', stop, true);
}
