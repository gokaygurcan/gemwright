export interface FileSystem {
  mkdirTree(path: string): void;
  mount(type: unknown, options: object, path: string): void;
  filesystems: { IDBFS?: unknown };
  syncfs(populate: boolean, callback: (error?: Error) => void): void;
  open(path: string, mode: string): { fd: number };
  close(stream: { fd: number }): void;
  ftruncate(fd: number, length: number): void;
  write(stream: { fd: number }, data: Uint8Array, offset: number, length: number, position: number): void;
}
export interface NativeModule {
  FS: FileSystem;
  HEAPU8: Uint8Array;
  canvas: HTMLCanvasElement;
  _malloc(bytes: number): number;
  _wasm_push_key(down: number, key: number, scan: number, mod: number, repeat: number): void;
  _wasm_push_text(pointer: number): void;
  _wasm_push_mouse_motion(x: number, y: number, dx: number, dy: number, buttons: number): void;
  _wasm_push_mouse_button(down: number, button: number, x: number, y: number): void;
  _wasm_push_mouse_wheel(dx: number, dy: number, x: number, y: number): void;
  _wasm_push_window_focus(focused: number): void;
  _wasm_push_mouse_in_window(inside: number): void;
}
export interface Runtime {
  runMain(): Promise<void>;
  getAssemblyExports(
    name: string
  ): Promise<{ ClassicUO: { Wasm: { WasmViewport: { ResizeGame(width: number, height: number): Promise<void> } } } }>;
}
export interface RuntimeBuilder {
  withModuleConfig(config: {
    canvas: HTMLCanvasElement;
    preRun: ((module: NativeModule) => void)[];
    onAbort(reason: unknown): void;
  }): RuntimeBuilder;
  withEnvironmentVariable(name: string, value: string): RuntimeBuilder;
  create(): Promise<Runtime>;
}
