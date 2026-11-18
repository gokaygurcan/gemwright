// The judgements a resident's decisions rest on, in one place: the values residents live by, and
// what the analyzer's lab changes to see what each one changes (packages/analyze replay-runner.ts).
export const defaults = {
  // How near a spawner it goes to see what is there (planning.ts): well within the client's view.
  seekRange: 8,
  // How far it sees: a spawner nearer needs no going to (ventures.ts), the client's view range.
  sight: 18,
  // How many passes the shard's word on a spawner counts as, before its own visits bear it out.
  spawnerPrior: 2,
  // Tiles a second it walks at until it has been seen to walk (ServUO: a step every 0.4 seconds).
  walkPace: 2.5,
  // How long a spawner seen empty takes to fill again, as a share of its spawns' own delay.
  refillScale: 1,
  // Tries and successes a plan is credited with before any are known (beliefs.ts chance).
  chancePrior: 1,
  // A rate at or below this is no work at all: it changes course instead (live.ts).
  changeCourseBelow: -1,
  // How much better another plan must be to leave the one under way, times its patience (live.ts).
  patienceScale: 1,
  // Seconds a criminal stays one (ServUO: two minutes), barred from guarded towns and open to anyone.
  criminalSeconds: 120,
  // Seconds a murder count lasts (ServUO: eight hours of game time); five make it red.
  murderSeconds: 28_800,
  // Seconds of its usual progress a point of karma is worth, as far as it is honourable.
  karmaWorth: 1
};

export type Tuning = typeof defaults;

export const tuning: Tuning = { ...defaults };

// The lab's values for a while, then the defaults again.
export function tune(values: Partial<Tuning>) {
  Object.assign(tuning, defaults, values);
}
