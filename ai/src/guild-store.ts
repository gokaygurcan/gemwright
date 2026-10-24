import { Database } from 'bun:sqlite';

// What residents remember of their guilds, alliances and wars, in the resident database. The
// server holds the real guilds; these rows are written only on its confirmations (guilds.ts,
// guild-wars.ts), so each leader knows whom it asked and what was answered. Without the shared
// database (local runs, tests) the same tables live in memory.
export type Side = 'order' | 'chaos';
export interface GuildRow {
  name: string;
  abbr: string;
  side: Side;
  leader: string;
  founded_at: number;
  cap: number;
  // The side's alliance (guild-wars.ts): proposed to this guild, or joined.
  alliance: string | null;
  alliance_status: 'proposed' | 'member' | null;
}
export interface WarRow {
  id: number;
  declarer: string;
  opponent: string;
  hours: number;
  declared_at: number;
  started_at: number | null;
  ends_at: number | null;
  status: 'declared' | 'active' | 'over';
}

const schema = `
  CREATE TABLE IF NOT EXISTS guilds (
    name TEXT PRIMARY KEY, abbr TEXT NOT NULL UNIQUE, side TEXT NOT NULL, leader TEXT NOT NULL,
    founded_at INTEGER NOT NULL, cap INTEGER NOT NULL, alliance TEXT, alliance_status TEXT
  );
  CREATE TABLE IF NOT EXISTS guild_members (member TEXT PRIMARY KEY, guild TEXT NOT NULL, joined_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS guild_wars (
    id INTEGER PRIMARY KEY AUTOINCREMENT, declarer TEXT NOT NULL, opponent TEXT NOT NULL, hours INTEGER NOT NULL, declared_at INTEGER NOT NULL,
    started_at INTEGER, ends_at INTEGER, status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS war_kills (
    at INTEGER NOT NULL, killer TEXT NOT NULL, victim TEXT NOT NULL, killer_guild TEXT NOT NULL, war INTEGER
  );`;
let db = new Database(':memory:');
db.exec(schema);
export const attachGuilds = (database: Database) => {
  database.exec(schema);
  db = database;
};

export const guilds = () => db.query<GuildRow, []>('SELECT * FROM guilds ORDER BY founded_at').all();
export const guildNamed = (name: string) =>
  db.query<GuildRow, [string]>('SELECT * FROM guilds WHERE name = ?').get(name);
export const guildOfMember = (member: string) =>
  db.query<{ guild: string }, [string]>('SELECT guild FROM guild_members WHERE member = ?').get(member)?.guild;
export const memberCount = (guild: string) =>
  db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM guild_members WHERE guild = ?').get(guild)?.n ?? 0;

export function foundGuild(row: Omit<GuildRow, 'alliance' | 'alliance_status'>) {
  db.run('INSERT INTO guilds (name, abbr, side, leader, founded_at, cap) VALUES (?, ?, ?, ?, ?, ?)', [
    row.name,
    row.abbr,
    row.side,
    row.leader,
    row.founded_at,
    row.cap
  ]);
  joinGuild(row.leader, row.name);
}
export const joinGuild = (member: string, guild: string) =>
  db.run('INSERT OR REPLACE INTO guild_members (member, guild, joined_at) VALUES (?, ?, ?)', [
    member,
    guild,
    Date.now()
  ]);
export const setAlliance = (guild: string, alliance: string | null, status: GuildRow['alliance_status']) =>
  db.run('UPDATE guilds SET alliance = ?, alliance_status = ? WHERE name = ?', [alliance, status, guild]);

// Wars past their end are over (ServUO ends them itself, Guild.CheckExpiredWars); a declaration
// nobody answered within six hours lapses.
export function currentWar(): WarRow | undefined {
  const now = Date.now();
  db.run("UPDATE guild_wars SET status = 'over' WHERE status = 'active' AND ends_at < ?", [now]);
  db.run("DELETE FROM guild_wars WHERE status = 'declared' AND declared_at < ?", [now - 6 * 3_600_000]);
  return (
    db.query<WarRow, []>("SELECT * FROM guild_wars WHERE status != 'over' ORDER BY declared_at DESC LIMIT 1").get() ??
    undefined
  );
}
export const lastWarEnd = () =>
  db.query<{ at: number | null }, []>("SELECT MAX(ends_at) AS at FROM guild_wars WHERE status = 'over'").get()?.at ??
  undefined;
export const declareWar = (declarer: string, opponent: string, hours: number) =>
  db.run("INSERT INTO guild_wars (declarer, opponent, hours, declared_at, status) VALUES (?, ?, ?, ?, 'declared')", [
    declarer,
    opponent,
    hours,
    Date.now()
  ]);
export const startWar = (war: WarRow) =>
  db.run("UPDATE guild_wars SET status = 'active', started_at = ?, ends_at = ? WHERE id = ?", [
    Date.now(),
    Date.now() + war.hours * 3_600_000,
    war.id
  ]);
export const recordKill = (killer: string, victim: string, guild: string, war?: number) =>
  db.run('INSERT INTO war_kills (at, killer, victim, killer_guild, war) VALUES (?, ?, ?, ?, ?)', [
    Date.now(),
    killer,
    victim,
    guild,
    war ?? null
  ]);
export const guildDb = () => db;
