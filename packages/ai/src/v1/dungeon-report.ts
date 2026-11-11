import type { DungeonRunRecord } from './store';

// Summarizes recorded dungeon runs: per dungeon, how solo runs and parties went; per party, who
// mustered, whether it assembled, and how it ended. A run succeeded when it climbed out (or its
// party did) without anyone dying.
const succeeded = (runs: DungeonRunRecord[]) =>
  runs.every((run) => run.assembled) &&
  runs.every((run) => run.deaths === 0) &&
  runs.some((run) => run.outcome === 'climbed out');

export function dungeonReport(records: DungeonRunRecord[]) {
  const parties = new Map<string, DungeonRunRecord[]>();
  for (const record of records)
    if (record.partyId) parties.set(record.partyId, [...(parties.get(record.partyId) ?? []), record]);
  const solo = records.filter((record) => !record.partyId);
  const dungeons: Record<string, Record<string, number>> = {};
  const tally = (dungeon: string, key: string, by = 1) => {
    dungeons[dungeon] ??= {};
    dungeons[dungeon][key] = (dungeons[dungeon][key] ?? 0) + by;
  };
  for (const run of solo) {
    tally(run.dungeon, 'soloRuns');
    if (succeeded([run])) tally(run.dungeon, 'soloSucceeded');
    tally(run.dungeon, 'kills', run.kills);
    tally(run.dungeon, 'deaths', run.deaths);
  }
  const partyRows = [...parties.entries()].map(([id, runs]) => {
    const leader = runs.find((run) => run.role === 'leader') ?? runs[0];
    const dungeon = leader?.dungeon ?? 'unknown';
    const assembled = runs.every((run) => run.assembled);
    tally(dungeon, assembled ? 'partiesAssembled' : 'partiesAbandoned');
    if (succeeded(runs)) tally(dungeon, 'partiesSucceeded');
    const kills = runs.reduce((sum, run) => sum + run.kills, 0);
    const deaths = runs.reduce((sum, run) => sum + run.deaths, 0);
    tally(dungeon, 'kills', kills);
    tally(dungeon, 'deaths', deaths);
    return {
      id,
      dungeon,
      leader: leader?.name,
      plannedSize: leader?.plannedSize,
      members: runs.map((run) => ({ name: run.name, skills: run.members.find((m) => m.name === run.name)?.skills })),
      assembled,
      succeeded: succeeded(runs),
      startedAt: leader?.startedAt,
      endedAt: runs
        .map((run) => run.endedAt)
        .sort()
        .at(-1),
      outcomes: runs.map((run) => `${run.name}: ${run.outcome}`),
      deepest: Math.max(...runs.map((run) => run.deepest)),
      kills,
      deaths
    };
  });
  return {
    runs: records.length,
    soloRuns: solo.length,
    parties: partyRows.length,
    dungeons,
    recentParties: partyRows.slice(-20),
    recentSolo: solo.slice(-20).map(({ name, dungeon, outcome, deepest, kills, deaths, endedAt }) => ({
      name,
      dungeon,
      outcome,
      deepest,
      kills,
      deaths,
      endedAt
    }))
  };
}
