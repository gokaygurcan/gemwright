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
