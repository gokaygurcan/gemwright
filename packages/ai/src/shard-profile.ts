import type { Race } from './appearance';
import { info } from './log';
import { CLIENT_VERSION } from './protocol/packets';

// The shard the runtime plays on, from the shard's own gemwright.json. Only ServUO is supported:
// classic protocol 7.0.45.1, accounts made by ordinary login when the shard auto-creates them, and
// characters made at the creation screen. The expansion sets the rules that differ between eras.
const eras = ['base', 't2a', 'uor', 'td', 'lbr', 'aos', 'se', 'ml', 'sa', 'hs', 'tol', 'ej'] as const;
export type Expansion = (typeof eras)[number];

export interface ShardProfile {
  emulator: 'servuo';
  protocol: string;
  expansion: Expansion;
  // Races new residents are created as (gemwright.json `ai.races`).
  races: Race[];
  // The shard's timezone (gemwright.json `timezone`), for the time of day residents live by.
  timezone: string;
  provisioning: {
    // Logging in with an unknown account creates it (ServUO AccountHandler AutoAccountCreation).
    autoCreateAccounts: boolean;
    // ServUO MaxAccountsPerIP; a whole population logs in from one address.
    accountsPerIp?: number;
  };
}

// ServUO pub57 ships Expansion EJ and AutoAccountCreation on; a shard without gemwright.json is
// assumed to match.
const defaults: ShardProfile = {
  emulator: 'servuo',
  protocol: `classic-${CLIENT_VERSION}`,
  expansion: 'ej',
  races: ['human', 'elf'],
  timezone: 'UTC',
  provisioning: { autoCreateAccounts: true }
};
let current = defaults;

export const shardProfile = () => current;
export const atLeast = (era: Expansion, profile = current) => eras.indexOf(profile.expansion) >= eras.indexOf(era);

export async function loadShardProfile(path?: string): Promise<ShardProfile> {
  if (!path) {
    current = defaults;
    return current;
  }
  const value = (await Bun.file(path).json()) as Record<string, unknown>;
  if (value.emulator !== 'servuo')
    throw new Error(`Only ServUO shards are supported (gemwright.json says ${value.emulator})`);
  const expansion = String(value.expansion ?? 'ej') as Expansion;
  if (!eras.includes(expansion)) throw new Error(`Unknown expansion ${expansion} in gemwright.json`);
  const servuo = (value.servuo ?? {}) as Record<string, unknown>;
  // Elves arrive with Mondain's Legacy and gargoyles with Stygian Abyss. Gargoyles wear their own
  // gear, so they are created only when gemwright.json lists them.
  const listed = ((value.ai as { races?: unknown } | undefined)?.races ?? ['human', 'elf']) as string[];
  const races = (['human', 'elf', 'gargoyle'] as const).filter(
    (race) =>
      listed.includes(race) &&
      (race === 'human' ||
        (race === 'elf' && atLeast('ml', { ...defaults, expansion })) ||
        atLeast('sa', { ...defaults, expansion }))
  );
  const dropped = listed.filter((race) => !(races as readonly string[]).includes(race));
  if (dropped.length)
    info(
      `[profile] ai.races ${dropped.join(', ')} not available in the ${expansion} expansion (elves need ml, gargoyles sa); creating ${races.join(', ') || 'human'} only`
    );
  current = {
    ...defaults,
    expansion,
    races: races.length ? races : ['human'],
    timezone: typeof value.timezone === 'string' ? value.timezone : 'UTC',
    provisioning: {
      autoCreateAccounts: servuo.autoCreateAccounts !== false,
      accountsPerIp: typeof servuo.accountsPerIp === 'number' ? servuo.accountsPerIp : undefined
    }
  };
  return current;
}

// Refuses to provision new residents on a shard that cannot create their accounts, and warns when
// the per-address account limit would stop part of them.
export function checkProvisioning(newAccounts: number, profile = current) {
  if (newAccounts <= 0) return;
  if (!profile.provisioning.autoCreateAccounts)
    throw new Error(
      `${newAccounts} resident(s) need new accounts, but the shard does not auto-create accounts (servuo.autoCreateAccounts)`
    );
  const limit = profile.provisioning.accountsPerIp;
  if (limit !== undefined && limit > 0 && newAccounts > limit)
    info(
      `[profile] ${newAccounts} new accounts from one address, but the shard allows ${limit} per IP (servuo.accountsPerIp); the rest will be refused`
    );
}

// Rules that change with the era (pinned ServUO Scripts/Skills/Stealth.cs).
export const servuoRules = (profile = current) => ({
  // Hiding base needed before Stealth works.
  stealthHidingRequirement: atLeast('ml', profile) ? 30 : atLeast('se', profile) ? 50 : 80,
  // Stealth skill points per allowed hidden step.
  stealthPointsPerStep: atLeast('aos', profile) ? 5 : 10,
  // Object property lists (item durability, weapon and armor specs) exist from AOS on.
  propertyLists: atLeast('aos', profile)
});
