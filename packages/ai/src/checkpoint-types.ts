import type { DecisionMemory } from './decisions';
import type { ExperienceMemory } from './experience';
import type { MountMemory } from './mount-types';
import type { ObjectiveFailure } from './objective-memory';
import type { ResidentMemory } from './resident-memory-types';

export interface Checkpoint {
  schemaVersion?: number;
  personal?: ResidentMemory;
  objectives?: Record<string, ObjectiveFailure>;
  decisions?: DecisionMemory;
  experience?: ExperienceMemory;
  mount?: MountMemory;
  packAnimal?: MountMemory & { load?: number; searches?: number; abandoned?: number };
  // Last banker-reported balance; vendors on the verified profile can charge it directly.
  funds?: { bank: number; at: number };
  // Side trade (side-trade.ts): funds at the last check, and until when it works the side trade.
  sideTrade?: { checkAt: number; funds: number; until: number };
  stock?: { ingots: number; at: number };
  // An interrupted dungeon run and its party.
  dungeon?: {
    name: string;
    until: number;
    startedAt: string;
    visited: string[];
    avoided: string[];
    room?: string;
    exiting: boolean;
    deepest: number;
    kills: number;
    deaths: number;
    party?: { id: string; leader: number; role: 'leader' | 'member'; plannedSize: number; members: string[] };
  };
  // A corpse left in a dungeon after a death nobody could resurrect (dungeon-death.ts).
  dungeonCorpse?: { dungeon: string; x: number; y: number; z: number; diedAt: string; attempts: number };
  // The resident's current life phase and when it ends (life.ts); `city` is a visit's destination.
  life?: { phase: string; until: number; city?: string };
  // Best price a vendor kind has offered per item graphic (a thief's takings, thief-actions.ts).
  prices?: Record<string, { service: string; price: number }>;
  // Exceptional crafted pieces kept from sale and banked (miner-crafting.ts, craft-training.ts).
  keep?: number[];
  // The tamer's kept fighting pet (tamer-pet.ts).
  companion?: { serial: number; name: string; minTame: number };
  // Last NPC training attempt per skill name.
  training?: Record<string, number>;
  // Combat spells confirmed in the spellbook, and when the book was last checked (magery.ts).
  spells?: { checked: number; has: number[] };
  // When to ask a shopkeeper for the next bulk order (bulk-orders.ts).
  bulkOrders?: { nextAt: number; stalledUntil?: number };
  // What the resident is doing: its activity, the phase within it, and the phase's own words
  // ("Heading to the orc spawn near 634,1462"), which conversation answers from.
  goal: { kind: string; phase: string; note?: string } | null;
  memories: { at: string; text: string }[];
  // Keyed by observed character name; seen/lastSeen are maintained by relationships.ts.
  relationships: Record<string, { affinity: number; note: string; seen?: number; lastSeen?: string; peer?: boolean }>;
  // depleted: mining spots and vein blocks with the time their ore may have respawned.
  landmarks?: { forges: { x: number; y: number; z: number }[]; depleted?: { key: string; until: number }[] };
  hunting?: {
    loot: number[];
    killsSinceBank: number;
    pending: 'hunt' | 'return';
    // Cemetery currently hunted (cemeteries.ts); absent means Britain.
    ground?: string;
    reconsiderAt?: number;
    encounter?: {
      opponent: number;
      startedAt: string;
      position?: { x: number; y: number; z: number };
      body?: number;
      memoryId?: string;
    };
    recovery?: {
      stage: 'healer' | 'corpse' | 'equipment' | 'ready';
      diedAt: string;
      ownerName: string;
      attempts: number;
      outcome?: string;
      locationSource?: 'death-status' | 'last-seen';
    };
    deathSite?: { x: number; y: number; z: number };
    corpse?: { serial: number; x: number; y: number; z: number };
  };
  mining?: {
    smeltsSinceBank: number;
    smeltsBeforeBank: number;
    smeltAtWeightRatio: number;
    bankAtWeightRatio: number;
    pending?: 'smelt' | 'bank';
  };
}
