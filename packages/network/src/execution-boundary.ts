import type { EventEmitter } from 'node:events';

import { waitForUpdate } from './session-observation';
import type { WaitContext, WaitOptions } from './wait-options';

export class ExecutionBoundary {
  private activity?: () => void;
  private checking = false;
  private context?: (options: WaitOptions) => WaitContext;
  setCheck(check: () => void) {
    this.activity = check;
  }
  setContext(context: (options: WaitOptions) => WaitContext) {
    this.context = context;
  }
  check() {
    if (this.checking) return true;
    this.checking = true;
    try {
      this.activity?.();
      return !!this.activity;
    } finally {
      this.checking = false;
    }
  }
  async wait(
    events: EventEmitter,
    state: () => { phase: string; failureReason: string | null },
    predicate: () => boolean,
    label: string,
    timeout: number,
    options: WaitOptions
  ) {
    const context = this.context?.(options);
    const signal =
      options.signal && context?.signal && options.signal !== context.signal
        ? AbortSignal.any([options.signal, context.signal])
        : (options.signal ?? context?.signal);
    let failure: unknown;
    try {
      return await waitForUpdate(
        events,
        state,
        predicate,
        label,
        timeout,
        options.interruptible === false ? undefined : () => this.check(),
        { ...options, signal }
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      context?.settled?.(failure);
    }
  }
}
