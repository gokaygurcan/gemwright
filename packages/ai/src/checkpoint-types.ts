import type { DecisionMemory } from './decisions';
import type { ExperienceMemory } from './experience';
import type { MountMemory } from './mount-types';
import type { ObjectiveFailure } from './objective-memory';
import type { ResidentMemory } from './resident-memory-types';

export interface Checkpoint {
  schemaVersion?: number;
  workGoal?: import('./resident-goal').GoalMemory;
  personal?: ResidentMemory;
  objectives?: Record<string, ObjectiveFailure>;
  decisions?: DecisionMemory;
  experience?: ExperienceMemory;
  mount?: MountMemory;
  // fullLoads: loads that filled the pack (pack-animal.ts buys one only after a few).
  packAnimal?: MountMemory & { load?: number; searches?: number; abandoned?: number; fullLoads?: number };
  // A game master's GEMWRIGHT::STOP (gm.ts): set until GEMWRIGHT::CONTINUE or the staff member
  // leaves the resident's view.
  halt?: { at: number; by: number; name?: string };
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
  life?: {
    phase: string;
    until: number;
    city?: string;
    decision?: import('./decisions').DecisionPick;
    before?: import('./work-evidence').WorkEvidence;
  };
  // Best price a vendor kind has offered per item graphic (a thief's takings, thief-actions.ts).
  prices?: Record<string, { service: string; price: number }>;
  // Exceptional crafted pieces kept from sale and banked (miner-crafting.ts, craft-training.ts).
  keep?: number[];
  // Equipment it picked up but cannot use (wrong trade, needs, race or gender): sold at once, or
  // dropped for another resident when no shop takes it (inventory-use.ts, selling.ts).
  forSale?: number[];
  // The tamer's kept fighting pet (tamer-pet.ts).
  companion?: { serial: number; name: string; minTame: number };
  // Last NPC training attempt per skill name.
  training?: Record<string, number>;
  // Combat spells confirmed in the spellbook, and when the book was last checked (magery.ts).
  spells?: { checked: number; has: number[] };
  // A spare tool of the resident's trade kept in the bank against a death (insurance.ts).
  insurance?: { tool: number; graphic: number };
  // The young player ticket's prize (young-ticket.ts): chosen and not yet kept or sold, or done.
  ticketPrize?: 'pending' | 'done';
  // When a fighter may next cross to another town's shop for supplies (fighter-town.ts restock).
  farShopAfter?: number;
  // When a fighter may next look in its bank for supplies (fighter-equipment.ts).
  bankLookAfter?: number;
  // A fighter's recent retreats by hunting ground: twice in half an hour sends it elsewhere (fighter.ts).
  retreats?: { ground: string; at: number }[];
  // The resident's standing at its last break: the next one waits for growth since (life.ts).
  lastBreak?: { at: number; wealth: number; skillTotal: number };
  // How the resident sees itself (self.ts), refreshed each turn, and its last look into its bank box.
  self?: import('./self').SelfImage;
  bankSeen?: { at: string; items: number; worth: number };
  // Its own young player ticket left by a bank for another young player to use (young-ticket.ts).
  ticketOffered?: { ticket: number; x: number; y: number; at: number };
  // What each side trade earned this resident (side-trade.ts): gold and minutes spent.
  paid?: Record<string, { gold: number; minutes: number }>;
  // Recall runes this resident marked (recall.ts): where each one leads.
  runes?: { serial: number; label: string; x: number; y: number; book?: number; page?: number }[];
  // When to ask a shopkeeper for the next bulk order (bulk-orders.ts).
  bulkOrders?: { nextAt: number; stalledUntil?: number; stalledReason?: string };
  // What the resident is doing: its activity, the phase within it, and the phase's own words
  // ("Heading to the orc spawn near 634,1462"), which conversation answers from.
  goal: { kind: string; phase: string; note?: string } | null;
  memories: { at: string; text: string }[];
  // Keyed by observed character name; seen/lastSeen are maintained by relationships.ts.
  relationships: Record<
    string,
    {
      affinity: number;
      note: string;
      seen?: number;
      lastSeen?: string;
      peer?: boolean;
      // What it made of them from their gear the last time it saw them (appraise.ts).
      appraisal?: import('./appraise').Appraisal;
    }
  >;
  // depleted: mining spots and vein blocks with the time their ore may have respawned.
  landmarks?: {
    forges: { x: number; y: number; z: number }[];
    smithies?: import('./smithing-stations').SmithingStation[];
    depleted?: { key: string; until: number }[];
    // Vendor spots that answered a menu, per map, town and service (craft-training.ts).
    vendors?: Record<string, { x: number; y: number; z: number; at: number }>;
  };
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
      capability?: import('./combat-capability').CombatCapability;
      creatureName?: string;
    };
    recovery?: {
      stage: 'healer' | 'corpse' | 'equipment' | 'ready';
      diedAt: string;
      ownerName: string;
      attempts: number;
      outcome?: string;
      locationSource?: 'death-status' | 'last-seen';
      retryAt?: number;
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

// A checkpoint is rewritten for every resident every few seconds: anything unbounded inside it is
// paid for twice, in memory and in durable writes (one 260 KB checkpoint times a hundred residents
// is how a save burst filled the write queue). Histories keep their recent tail, which is what
// behaviour reads; everything else in the checkpoint is already bounded where it is written.
const keepRecent = <T>(map: Record<string, T> | undefined, max: number, rank: (value: T) => number) => {
  if (!map) return map;
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  return Object.fromEntries(entries.sort((a, b) => rank(b[1]) - rank(a[1])).slice(0, max));
};
export function boundCheckpoint(checkpoint: Checkpoint): Checkpoint {
  if (checkpoint.memories.length > 50) checkpoint.memories = checkpoint.memories.slice(-50);
  const decisions = checkpoint.decisions;
  if (decisions?.history && decisions.history.length > 80) decisions.history = decisions.history.slice(-80);
  const goal = checkpoint.workGoal;
  if (goal) {
    // Failed objectives are relearned; a dozen recent ones is all a plan consults.
    goal.failed = keepRecent(goal.failed, 12, (entry) => entry.until);
    goal.outcomes = goal.outcomes?.slice(-20);
    goal.assumptions = goal.assumptions?.slice(-20);
  }
  checkpoint.objectives = keepRecent(checkpoint.objectives, 32, (entry) => entry.until ?? 0);
  const relationships = keepRecent(checkpoint.relationships, 60, (entry) =>
    entry.lastSeen ? Date.parse(entry.lastSeen) : 0
  );
  if (relationships) checkpoint.relationships = relationships;
  const landmarks = checkpoint.landmarks;
  if (landmarks) {
    landmarks.vendors = keepRecent(landmarks.vendors, 24, (entry) => entry.at);
    if (landmarks.forges.length > 50) landmarks.forges = landmarks.forges.slice(-50);
    landmarks.depleted = landmarks.depleted?.slice(-300);
  }
  if (checkpoint.retreats && checkpoint.retreats.length > 8) checkpoint.retreats = checkpoint.retreats.slice(-8);
  if (checkpoint.forSale && checkpoint.forSale.length > 40) checkpoint.forSale = checkpoint.forSale.slice(-40);
  return checkpoint;
}
