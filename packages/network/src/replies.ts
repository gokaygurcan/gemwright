// What the shard says back, named once. These localization numbers are protocol vocabulary: the
// same number written in a dozen modules was the same fact written a dozen times, and a caller that
// mistyped one carried a silent failure. Nothing here decides anything — the AI supplies the policy,
// this package supplies the names.
export interface ActionsReplies {
  buy: number;
  sell: number;
  bank: number;
  bulkOrderInfo: number;
  bribe: number;
  claimRewards: number;
  convertMageArmor: number;
}
export const Actions: ActionsReplies = {
  buy: 3006103,
  sell: 3006104,
  bank: 3006105,
  bulkOrderInfo: 3006152,
  bribe: 1152294,
  claimRewards: 1155593,
  convertMageArmor: 1154114
};

export interface ShardMessageReplies {
  tooFar: number;
  targetNotSeen: number;
  noSuchSpell: number;
  bandagesApplied: number;
  corpseDenied: number;
  tooSoon: number;
  mustWait: number;
}
export const ShardMessage: ShardMessageReplies = {
  tooFar: 500446, // a container, corpse or vendor target out of reach
  targetNotSeen: 500237,
  noSuchSpell: 500015,
  bandagesApplied: 500969,
  corpseDenied: 1005035, // Corpse.CheckLoot refuses a shared kill
  tooSoon: 500118, // "You must wait a few moments to use another skill."
  mustWait: 500119 // Mobile.SendActionMessage: an action inside the action delay
};

// ServUO Mining.cs / HarvestSystem replies.
export interface MiningReplies {
  digPrompt: number;
  cannotMineThere: number;
  cannotMineThat: number;
  noMetal: number;
  outOfRange: number;
  alreadyMined: number;
  failedRoll: number;
}
export const Mining: MiningReplies = {
  digPrompt: 503033,
  cannotMineThere: 501862,
  cannotMineThat: 501863,
  noMetal: 503040,
  outOfRange: 503041,
  alreadyMined: 503042,
  failedRoll: 503043
};

// ServUO Ore.OnDoubleClick replies.
export interface SmeltingReplies {
  unknownOre: number;
  tooLean: number;
  success: number;
  reduced: number;
}
export const Smelting: SmeltingReplies = {
  unknownOre: 501986,
  tooLean: 501987,
  success: 501988,
  reduced: 501990
};

// ServUO AnimalTrainer / stable replies.
export interface StablingReplies {
  claimed: number;
  noneStabled: number;
  tooManyFollowers: number;
}
export const Stabling: StablingReplies = {
  claimed: 1042559,
  noneStabled: 502671,
  tooManyFollowers: 1049612
};

// ServUO BulkOrderSystem gumps and replies.
export interface BulkOrderReplies {
  offerTitle: number;
  exceptional: number;
  deedGump: number;
  nextOffer: number;
  pointsTitle: number;
  rewardsTitle: number;
  rewardConfirm: number;
  rewardGiven: number;
}
export const BulkOrder: BulkOrderReplies = {
  offerTitle: 1045133,
  exceptional: 1045141,
  deedGump: 1045138,
  nextOffer: 1072058,
  pointsTitle: 1157076,
  rewardsTitle: 1157082,
  rewardConfirm: 1074974,
  rewardGiven: 1073621
};

// The rest of the context entries the residents choose, named after their ServUO classes.
export interface ShardActionReplies {
  stay: number;
  follow: number;
  transfer: number;
  petAttack: number;
  trainerMenu: number;
  release: number;
  guildInfo: number;
  packAnimal: number;
  escortAsk: number;
  escortAccept: number;
  teachBase: number;
  partyAdd: number;
  partyRemove: number;
}
export const ShardAction: ShardActionReplies = {
  stay: 3006107, // StayEntry (pets)
  follow: 3006108, // FollowEntry (pets)
  transfer: 3006113, // TransferEntry: hands a pet to another player
  petAttack: 3006111, // the order that sends a pet at a target
  trainerMenu: 3006126, // the entry checked before an animal trainer will serve
  release: 3006118, // ReleaseEntry (pets)
  guildInfo: 3006115, // the guild master's information entry
  packAnimal: 3006145, // PackAnimal.CheckAccess: opens only for its owner
  escortAsk: 3006100, // an escort npc's offer
  escortAccept: 3006101, // accepting it
  teachBase: 3006000, // TeachEntry: 6000 + skill id
  partyAdd: 3000197, // Add Party (a player carries these; a vendor never does)
  partyRemove: 3000198 // Remove Party
};

// ServUO CraftItem / craft-gump replies.
export interface ShardCraftReplies {
  created: readonly number[];
  toolWornOut: number;
  stationMessage: number;
}
export const ShardCraft: ShardCraftReplies = {
  created: [1044154, 1044155, 1044156, 502785, 500279],
  toolWornOut: 1044038,
  stationMessage: 1044267
};

// ServUO Taming.cs replies.
export interface TamingReplies {
  tamed: number;
  failed: number;
}
export const Taming: TamingReplies = { tamed: 502799, failed: 502798 };

// ServUO Stealing.cs replies (see thief-skills.ts for the pinned-revision list).
export interface StealingReplies {
  failed: number;
  success: number;
  emptyHands: number;
  tooFar: number;
  equipped: number;
  guild: number;
  shopkeeper: number;
  cannotStealThat: number;
  redHanded: number;
  packFull: number;
}
export const Stealing: StealingReplies = {
  failed: 502723,
  success: 502724,
  emptyHands: 1005584,
  tooFar: 502703,
  equipped: 1005585,
  guild: 1005596,
  shopkeeper: 1005598,
  cannotStealThat: 502710,
  redHanded: 502704,
  packFull: 1048147
};

// ServUO Hiding.cs replies.
export interface HidingReplies {
  busy: number;
  hidden: number;
  cannotHide: number;
  cannotHideAlt: number;
}
export const Hiding: HidingReplies = { busy: 501238, hidden: 501240, cannotHide: 501237, cannotHideAlt: 501241 };

// ServUO Stealth.cs replies.
export interface StealthReplies {
  hideFirst: number;
  notHiddenEnough: number;
  tooMuchArmor: number;
  cannotNow: number;
  movesQuietly: number;
  failed: number;
}
export const Stealth: StealthReplies = {
  hideFirst: 502725,
  notHiddenEnough: 502726,
  tooMuchArmor: 502727,
  cannotNow: 1063086,
  movesQuietly: 502730,
  failed: 502731
};

// ServUO Banker.cs answers to the *balance* keyword.
export interface BankReplies {
  // "Thy current bank balance is ~1_AMOUNT~ gold."
  balance: number;
  // AccountGold variant: platinum and gold as two amounts (higher total first).
  accountBalance: number;
  // "I will not do business with a criminal!" — an answer, but not a balance.
  refused: number;
}
export const Bank: BankReplies = { balance: 1042759, accountBalance: 1155855, refused: 500389 };

// ServUO BaseVendor: the vendor found neither carried nor banked gold to cover the cost. The
// message varies by price (500191 for expensive purchases, 500192 otherwise).
export const Commerce = {
  cannotAfford: [500191, 500192] as readonly number[]
};

// ServUO bandaging outcomes.
export const Healing = {
  diedMidway: 500962, // you were unable to finish your work before you died
  outOfRange: 500963, // you did not stay close enough to heal your target
  barelyHelp: 500968 // you apply the bandages, but they barely help
};

// ServUO Fishing replies.
export const Fishing = {
  notBiting: 503172, // the fish don't seem to be biting here
  failed: 503171 // you fish a while, but fail to catch anything
};
