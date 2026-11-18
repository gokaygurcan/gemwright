import { logger } from './log';

// How long a returned open-ended behavior waits before it is run again in the same session.
const REPEAT_PAUSE_MS = 30_000;

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
  onRecovery?: (session: S, attempt: number, reason: string) => void;
  onResult?: (result: R) => void;
  shouldRepeat?: (result: R) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  let session = options.session;
  let recoveryAttempts = 0;
  let runs = 0;
  let reportedStillHere = false;
  let result: R | null = null;
  while (!options.stopping() && now() < options.deadline) {
    options.assertOwnership();
    try {
      runs++;
      result = await options.run(session, Math.max(0, (options.deadline - now()) / 1000));
      options.onResult?.(result);
      if (options.shouldRepeat?.(result) === false) break;
    } catch (error) {
      if (options.stopping()) break;
      // An open-ended run whose behavior threw while the character is still in the world (a road
      // ambush, a blocked goal, a loop guard) is a turn, not a logout: run it again after a pause.
      // Ending the session here is what made a fighter log out beside the monster he had just killed,
      // with its loot still on the ground.
      if (session.phase === 'ready' && !Number.isFinite(options.deadline)) {
        if (!reportedStillHere) {
          reportedStillHere = true;
          logger('behavior-supervisor').info(
            `[session] Behavior failed with the character still in the world (${error instanceof Error ? error.message : String(error)}); running it again after a pause`
          );
        }
        await sleep(REPEAT_PAUSE_MS + Math.random() * REPEAT_PAUSE_MS);
        continue;
      }
      if (!session.reconnectable) throw error;
    }
    if (options.stopping() || now() >= options.deadline) break;
    if (session.phase === 'ready') {
      // An open-ended run (Infinity: the deployed population) never ends while the character is
      // still in the world. A behavior that returned — a resident stranded where no goal can be
      // reached, a course that found no way — is run again after a pause. Ending the run there
      // logged the character out and back in, which is the churn a stranded resident must not cause.
      if (!Number.isFinite(options.deadline)) {
        if (!reportedStillHere) {
          reportedStillHere = true;
          logger('behavior-supervisor').info(
            '[session] Behavior ended with the character still in the world; running it again after a pause'
          );
        }
        await sleep(REPEAT_PAUSE_MS + Math.random() * REPEAT_PAUSE_MS);
        continue;
      }
      break;
    }
    if (!session.reconnectable)
      throw new Error(
        `Behavior session failed with a non-retryable error: ${session.failureReason ?? 'unknown protocol or character error'}`
      );
    const failureReason = session.failureReason ?? 'unspecified interruption';
    session.close();
    while (!options.stopping() && now() < options.deadline) {
      options.assertOwnership();
      if (recoveryAttempts >= options.maxReconnects)
        throw new Error('Behavior reconnect budget exhausted; progress remains checkpointed');
      await sleep(Math.min(500 * 2 ** recoveryAttempts, 5000, Math.max(0, options.deadline - now())));
      if (options.stopping() || now() >= options.deadline) break;
      recoveryAttempts++;
      options.onRecovery?.(session, recoveryAttempts, failureReason);
      logger('behavior-supervisor').info(
        `[session] Reconnecting interrupted behavior (${recoveryAttempts}/${options.maxReconnects}); rebuilding player observations: ${failureReason}`
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const connected = await Promise.race([
          options.connect(),
          new Promise<null>((resolve) => {
            // An open-ended run (Infinity) never times out its reconnect.
            if (Number.isFinite(options.deadline))
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
