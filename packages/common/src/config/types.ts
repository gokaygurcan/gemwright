import type { Expansion } from '../game/expansions';
import type { Emulator } from './shard';

export interface DotnetSettings {
  clientFiles?: string;
  owner: string;
  autoCreateAccounts: boolean;
}

export interface ServuoSettings {
  clientFiles?: string;
  autoCreateAccounts: boolean;
  owner: string;
  accountsPerIp?: number;
  globalChat?: boolean;
  allowedClients?: string[];
}

export interface SphereSettings {
  scriptsSource: EmulatorSource;
  mysql?: boolean;
  clientFiles?: string;
  autoCreateAccounts: boolean;
  owner: string;
  maps: 'expansion' | 'felucca';
  mapSize: 'modern' | 'legacy';
  clientEncryption?: 'encrypted' | 'both' | 'unencrypted';
  rules?: SphereRules;
}

export interface SphereRules {
  combatFlags: number;
  archeryMovementDelay: number;
  damageEra: number;
  hitChanceEra: number;
  speedEra: number;
  speedScaleFactor: number;
  magicFlags: number;
  racialFlags: number;
  revealFlags: number;
  npcAI: number;
}

export interface EmulatorSource {
  repository: string;
  ref: string;
  revision: string;
}

export interface ShardConfig {
  schemaVersion?: 1;
  $schema?: string;
  packages?: Partial<Record<'server' | 'client' | 'ai', string>>;
  railway?: { project: string; environment: string; server?: string };
  connection?: { host: string; port: number; aiReady?: boolean };
  name: string;
  adminEmail?: string;
  url?: string;
  id: string;
  timezone: string;
  expansion: Expansion;
  emulator: Emulator;
  // The classic client players connect with (version string such as 7.0.45.1); residents speak it too.
  client?: { version: string };
  source?: EmulatorSource;
  runuo?: DotnetSettings;
  modernuo?: DotnetSettings;
  servuo?: ServuoSettings;
  sphere?: SphereSettings;
  ai?: AiSettings;
}

// AI residents (gemwright deploy --ai): how many, and whether Jev or the local rules decide.
export interface AiSettings {
  population?: number;
  decisions?: 'local' | 'jev';
  // Replies in each resident's own voice by Claude Haiku 5.5, guarded; authored lines otherwise.
  speech?: 'authored' | 'claude';
  // Races new residents are created as; human and elf by default (gargoyles need their own gear).
  races?: ('human' | 'elf' | 'gargoyle')[];
  // How unpredictable residents are, 0 (always the direct way) to 1: detours by real places,
  // brief stops, changes of plan in town. 0.3 by default.
  chaos?: number;
  // Whether the Order and Chaos guild alliances go to war with each other. Off by default.
  wars?: boolean;
  // Residents of a fixed size started in one city, by profession weight, counted within
  // population: { "New Haven": { count: 50, professions: { miner: 6, bard: 3 } } }.
  cohorts?: Record<string, { count: number; professions: Record<string, number> }>;
  // Whether every resident emotes the phase it is in above its head (watchStep): reads a stuck loop
  // in the game itself, before any log. Off by default; the shard turns it on while tuning.
  debug?: boolean;
}
