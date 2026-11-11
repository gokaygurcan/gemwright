export class DangerInterrupt extends Error {
  constructor() {
    super('Taking damage; leaving work to get to safety');
  }
}
export class InteractionInterrupt extends Error {
  constructor() {
    super('Player interaction takes priority; re-observe before resuming work');
  }
}
export class ActionBusy extends Error {}
export class ActionTimeout extends Error {}
export class ActionInterrupted extends Error {}

// A deliberate session break (session-habits.ts): the run ends on purpose, and must not be
// restarted by the supervisor or re-logged-in by the population until the habit's offline window.
export const SESSION_BREAK: unique symbol = Symbol('gemwright.session-break');
