// Visible debugging (shard `ai.debug`): residents emote the phase they are in above their heads, so
// a stuck loop reads in the game itself, before any log. Off unless the shard turns it on.
let enabled = false;

export function setDebug(value: boolean) {
  enabled = value;
}

export function debugEnabled() {
  return enabled;
}
