interface RecoverableSession {
  phase: string;
  reconnectable: boolean;
  failureReason?: string | null;
  close: () => void;
}

export async function superviseBehavior<S extends RecoverableSession, R>(options: {
  session: S;
  deadline: number;
  maxReconnects: number;
  stopping: () => boolean;
  assertOwnership: () => void;
  connect: () => Promise<S>;
  latestSession: () => S | null;
  run: (session: S, seconds: number) => Promise<R>;
  onResult?: (result: R) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  let session = options.session;
  let recoveryAttempts = 0;
  let runs = 0;
  let result: R | null = null;
  while (!options.stopping() && now() < options.deadline) {
    options.assertOwnership();
    try {
      runs++;
      result = await options.run(session, Math.max(0, (options.deadline - now()) / 1000));
      options.onResult?.(result);
    } catch (error) {
      if (options.stopping()) break;
      if (!session.reconnectable) throw error;
    }
    if (options.stopping() || now() >= options.deadline || session.phase === 'ready') break;
    if (!session.reconnectable)
      throw new Error(
        `Behavior session failed with a non-retryable error: ${session.failureReason ?? 'unknown protocol or character error'}`
      );
    session.close();
    while (!options.stopping() && now() < options.deadline) {
      options.assertOwnership();
      if (recoveryAttempts >= options.maxReconnects)
        throw new Error('Behavior reconnect budget exhausted; progress remains checkpointed');
      await sleep(Math.min(500 * 2 ** recoveryAttempts, 5000, Math.max(0, options.deadline - now())));
      if (options.stopping() || now() >= options.deadline) break;
      recoveryAttempts++;
      console.error(
        `[session] Reconnecting interrupted behavior (${recoveryAttempts}/${options.maxReconnects}); rebuilding player observations`
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const connected = await Promise.race([
          options.connect(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, options.deadline - now()));
          })
        ]);
        if (connected === null) {
          const pending = options.latestSession();
          pending?.close();
          return { session: pending ?? session, result, recoveryAttempts, runs };
        }
        session = connected;
        break;
      } catch (error) {
        if (options.stopping()) break;
        const failed = options.latestSession();
        if (!failed?.reconnectable) throw error;
        failed.close();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  return { session, result, recoveryAttempts, runs };
}
