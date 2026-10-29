export interface WaitOptions {
  signal?: AbortSignal;
  interruptible?: boolean;
  resource?: string;
  atomicGraceMs?: number;
  // What an expired protocol deadline means. `uncertain` (default) invalidates the session because
  // the operation cannot be judged; `timeout` leaves that judgement to the caller's re-observation.
  deadline?: 'uncertain' | 'timeout';
}
export interface WaitContext {
  signal?: AbortSignal;
  settled?: (error?: unknown) => void;
}
export class WaitTimeout extends Error {}
export class UncertainOperation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainOperation';
  }
}
