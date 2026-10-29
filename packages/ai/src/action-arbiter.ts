import { AsyncLocalStorage } from 'node:async_hooks';

import type { Command, CommandResource } from '@gemwright/network/commands';
import type { WaitOptions } from '@gemwright/network/wait-options';

import { ActionBusy, ActionInterrupted, ActionTimeout } from './action-errors';
import { inTrace, traceContext } from './telemetry';

export type ActionKind = 'work' | 'recovery' | 'interaction' | 'trade' | 'combat' | 'escape' | 'observation';
export const priority: Record<ActionKind, number> = {
  observation: 0,
  work: 10,
  recovery: 20,
  interaction: 30,
  trade: 50,
  combat: 70,
  escape: 100
};
export type ActionStage =
  | 'proposed'
  | 'authorized'
  | 'dispatched'
  | 'observed'
  | 'completed'
  | 'unconfirmed'
  | 'failed'
  | 'timed-out'
  | 'interrupted';
export interface ActionEvent {
  id: string;
  parentId?: string;
  intent: string;
  intentId?: string;
  kind: ActionKind;
  command?: string;
  stage: ActionStage;
  at: number;
  reason?: string;
  commands: number;
  stages: readonly ActionStage[];
}
export interface ActionScope {
  arbiter: ActionArbiter;
  id: string;
  intent: string;
  intentId?: string;
  kind: ActionKind;
  parent?: ActionScope;
  controller: AbortController;
  until: number;
  held: Set<CommandResource>;
  atomic: number;
  waitingTarget: number;
  commands: number;
  ended: boolean;
  stages: ActionStage[];
}
const context = new AsyncLocalStorage<ActionScope>();

export class ActionArbiter {
  private readonly active = new Set<ActionScope>();
  private readonly leases = new Map<CommandResource, ActionScope>();
  private readonly operations = new Map<CommandResource, symbol>();
  private readonly wakeups = new Set<() => void>();
  private closed = false;
  readonly history: ActionEvent[] = [];
  constructor(
    private readonly options: {
      emit?: (event: ActionEvent) => void;
      authorize?: (scope: ActionScope, command: Command) => void;
      interrupted?: (scope: ActionScope) => void;
    } = {}
  ) {}
  current() {
    const scope = context.getStore();
    return scope?.arbiter === this ? scope : undefined;
  }
  check(scope = this.current()) {
    if (this.closed) throw new ActionInterrupted('Session execution closed');
    if (scope?.ended) throw new ActionInterrupted('Action already ended; re-observe before acting');
    if (scope?.controller.signal.aborted) throw scope.controller.signal.reason;
    if (scope && Date.now() >= scope.until) {
      this.abort(scope, new ActionTimeout(`Action deadline exceeded: ${scope.intent}`));
      throw scope.controller.signal.reason;
    }
  }
  private event(scope: ActionScope, stage: ActionStage, command?: string, error?: unknown, id = scope.id) {
    const stages = id === scope.id ? scope.stages : [];
    stages.push(stage);
    const event: ActionEvent = {
      id,
      parentId: id === scope.id ? scope.parent?.id : scope.id,
      intent: scope.intent,
      intentId: scope.intentId,
      kind: scope.kind,
      command,
      stage,
      at: Date.now(),
      commands: scope.commands,
      stages: [...stages],
      reason: error instanceof Error ? error.message : error === undefined ? undefined : String(error)
    };
    this.history.push(event);
    if (this.history.length > 256) this.history.shift();
    this.options.emit?.(event);
  }
  private create(kind: ActionKind, intent: string, ms: number, detached = false): ActionScope {
    if (this.closed) throw new ActionInterrupted('Session execution closed');
    const current = detached ? undefined : this.current();
    if (current) this.check(current);
    const parent = current?.controller.signal.aborted ? undefined : current;
    const scope: ActionScope = {
      arbiter: this,
      id: crypto.randomUUID(),
      intent,
      intentId: parent?.intentId ?? (detached ? undefined : traceContext()?.intentId),
      kind,
      parent,
      controller: new AbortController(),
      until: Date.now() + ms,
      held: new Set(),
      atomic: 0,
      waitingTarget: 0,
      commands: 0,
      ended: false,
      stages: []
    };
    this.active.add(scope);
    this.event(scope, 'proposed');
    return scope;
  }
  private ancestor(parent: ActionScope, child: ActionScope): boolean {
    for (let scope: ActionScope | undefined = child; scope; scope = scope.parent) if (scope === parent) return true;
    return false;
  }
  abort(scope: ActionScope, reason: unknown) {
    if (scope.controller.signal.aborted) return;
    this.options.interrupted?.(scope);
    scope.controller.abort(reason);
    for (const child of this.active) if (child.parent === scope && child.kind !== 'escape') this.abort(child, reason);
    this.release(scope);
    this.wake();
  }
  interruptBelow(kind: ActionKind, reason: unknown) {
    for (const scope of this.active) {
      if (priority[scope.kind] >= priority[kind]) continue;
      const protectedChild = [...this.active].some(
        (child) =>
          !child.controller.signal.aborted && priority[child.kind] >= priority[kind] && this.ancestor(scope, child)
      );
      if (!protectedChild) this.abort(scope, reason);
    }
  }
  private release(scope: ActionScope) {
    if ((!scope.ended && !scope.controller.signal.aborted) || scope.atomic) return;
    for (const resource of scope.held) if (this.leases.get(resource) === scope) this.leases.delete(resource);
    scope.held.clear();
    this.wake();
  }
  private wake() {
    for (const wake of [...this.wakeups]) wake();
  }
  private async changed(scope: ActionScope) {
    this.check(scope);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        scope.controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(
        () => {
          clearTimeout(timer);
          this.wakeups.delete(done);
          scope.controller.signal.removeEventListener('abort', done);
          reject(new ActionBusy('Command resources remained busy'));
        },
        Math.min(1500, Math.max(1, scope.until - Date.now()))
      );
      this.wakeups.add(done);
      scope.controller.signal.addEventListener('abort', done, { once: true });
    });
    this.check(scope);
  }
  private claim(scope: ActionScope, command: Command, token: symbol): boolean {
    this.check(scope);
    this.options.authorize?.(scope, command);
    for (const resource of command.resources) {
      const owner = this.leases.get(resource);
      if (owner && owner !== scope && !this.ancestor(owner, scope)) {
        if (priority[scope.kind] > priority[owner.kind])
          this.abort(owner, new ActionInterrupted(`Preempted by ${scope.intent}`));
        if (this.leases.has(resource)) return false;
      }
      if (this.operations.has(resource)) return false;
    }
    for (const resource of command.resources) {
      if (!this.leases.has(resource)) {
        this.leases.set(resource, scope);
        scope.held.add(resource);
      }
      this.operations.set(resource, token);
    }
    return true;
  }
  private unlock(scope: ActionScope, command: Command, token: symbol) {
    for (const resource of command.resources)
      if (this.operations.get(resource) === token) this.operations.delete(resource);
    this.release(scope);
    this.wake();
  }
  private async race<T>(scope: ActionScope, body: Promise<T>): Promise<T> {
    let interrupted: (() => void) | undefined;
    try {
      return await Promise.race([
        body,
        new Promise<never>((_, reject) => {
          interrupted = () => reject(scope.controller.signal.reason);
          scope.controller.signal.addEventListener('abort', interrupted, { once: true });
          if (scope.controller.signal.aborted) interrupted();
        })
      ]);
    } finally {
      if (interrupted) scope.controller.signal.removeEventListener('abort', interrupted);
    }
  }
  async run<T>(kind: ActionKind, intent: string, body: () => Promise<T>, ms = 120_000, detached = false): Promise<T> {
    const scope = this.create(kind, intent, ms, detached);
    const parentAbort = () => this.abort(scope, scope.parent?.controller.signal.reason);
    if (kind !== 'escape') scope.parent?.controller.signal.addEventListener('abort', parentAbort, { once: true });
    const timer = setTimeout(() => this.abort(scope, new ActionTimeout(`Action deadline exceeded: ${intent}`)), ms);
    timer.unref();
    try {
      this.event(scope, 'authorized');
      const result = await this.race(
        scope,
        context.run(scope, async () => {
          this.check(scope);
          return inTrace(
            {
              traceId: scope.intentId ?? (detached ? scope.id : (traceContext()?.traceId ?? scope.id)),
              intentId: scope.intentId,
              actionId: scope.id,
              parentId: scope.parent?.id
            },
            body
          );
        })
      );
      this.check(scope);
      this.event(
        scope,
        result === false ? 'failed' : 'completed',
        undefined,
        result === false ? new Error('Observed action refusal') : undefined
      );
      return result;
    } catch (error) {
      const stage =
        error instanceof ActionTimeout ? 'timed-out' : scope.controller.signal.aborted ? 'interrupted' : 'failed';
      this.event(scope, stage, undefined, error);
      this.abort(scope, error);
      throw error;
    } finally {
      clearTimeout(timer);
      scope.parent?.controller.signal.removeEventListener('abort', parentAbort);
      scope.ended = true;
      this.active.delete(scope);
      this.release(scope);
    }
  }
  execute(command: Command, invoke: () => unknown): unknown {
    const current = this.current();
    if (!current) {
      if (command.async)
        return this.run(
          command.resources.length ? 'work' : 'observation',
          `command:${command.name}`,
          async () => this.execute(command, invoke),
          15_000
        );
      const scope = this.create('work', `command:${command.name}`, 15_000);
      try {
        this.event(scope, 'authorized');
        const result = context.run(scope, () => this.execute(command, invoke));
        this.event(scope, command.confirmed ? 'completed' : 'unconfirmed');
        return result;
      } finally {
        scope.ended = true;
        this.active.delete(scope);
        this.release(scope);
      }
    }
    const scope = current;
    const id = crypto.randomUUID();
    const token = Symbol();
    this.event(scope, 'proposed', command.name, undefined, id);
    let started = false;
    let finished = false;
    const start = () => {
      started = true;
      this.check(scope);
      scope.commands++;
      this.event(scope, 'authorized', command.name, undefined, id);
      if (!scope.stages.includes('dispatched')) this.event(scope, 'dispatched');
      this.event(scope, 'dispatched', command.name, undefined, id);
      if (command.atomic) scope.atomic++;
    };
    const done = (value: unknown) => {
      finished = true;
      if (command.confirmed) this.event(scope, 'observed', command.name, undefined, id);
      this.event(
        scope,
        value === false ? 'failed' : command.confirmed ? 'completed' : 'unconfirmed',
        command.name,
        value === false ? new Error('Observed command refusal') : undefined,
        id
      );
    };
    const failed = (error: unknown) => {
      if (!finished)
        this.event(
          scope,
          error instanceof ActionTimeout ? 'timed-out' : scope.controller.signal.aborted ? 'interrupted' : 'failed',
          command.name,
          error,
          id
        );
      throw error;
    };
    if (command.async)
      return (async () => {
        try {
          while (!this.claim(scope, command, token)) await this.changed(scope);
          start();
          const value = await invoke();
          done(value);
          this.check(scope);
          return value;
        } catch (error) {
          return failed(error);
        } finally {
          if (started && command.atomic) scope.atomic--;
          this.unlock(scope, command, token);
        }
      })();
    try {
      if (!this.claim(scope, command, token)) throw new ActionBusy(`Command resources busy: ${command.name}`);
      start();
      const value = invoke();
      done(value);
      return value;
    } catch (error) {
      return failed(error);
    } finally {
      this.unlock(scope, command, token);
    }
  }
  waitContext(options: WaitOptions) {
    const scope = this.current();
    if (!scope) return {};
    if (options.resource === 'target') scope.waitingTarget++;
    return {
      signal: scope.controller.signal,
      settled: (error?: unknown) => {
        if (error !== undefined && options.resource === 'target' && !scope.controller.signal.aborted)
          this.options.interrupted?.(scope);
        if (options.resource === 'target') scope.waitingTarget--;
      }
    };
  }
  snapshot() {
    return {
      active: [...this.active].map((scope) => ({
        id: scope.id,
        intentId: scope.intentId,
        intent: scope.intent,
        kind: scope.kind,
        until: scope.until,
        commands: scope.commands,
        interrupted: scope.controller.signal.aborted
      })),
      pendingCommands: this.operations.size,
      resources: [...this.leases.keys()]
    };
  }
  activeKind(kind: ActionKind) {
    return [...this.active].some((scope) => scope.kind === kind && !scope.ended && !scope.controller.signal.aborted);
  }
  close() {
    for (const scope of this.active) this.abort(scope, new ActionInterrupted('Session execution closed'));
    this.closed = true;
    this.wake();
  }
}
export function currentAction(sessionArbiter?: ActionArbiter) {
  return sessionArbiter?.current();
}
