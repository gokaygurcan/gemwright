export type EpisodeKind =
  | 'conversation'
  | 'gift'
  | 'rescue'
  | 'trade'
  | 'outing'
  | 'commitment-ended'
  | 'order'
  | 'support'
  | 'repair'
  | 'plan';
export interface Episode {
  id: string;
  at: number;
  kind: EpisodeKind;
  partner: number;
  name: string;
  detail: string;
  result: 'observed' | 'completed' | 'interrupted';
}
export interface Commitment {
  id: string;
  kind: 'follow' | 'hunt' | 'escort';
  partner: number;
  name: string;
  map: number;
  acceptedAt: number;
  until: number;
  lastSeen: number;
  plan?: SharedPlan;
  destination?: { x: number; y: number; z?: number };
  state: 'active' | 'paused' | 'completed' | 'cancelled';
  reason?: string;
  kills: number;
  lootDue: number;
  shareRetryAt?: number;
}
export interface WorkOrder {
  id: string;
  side: 'buy' | 'sell';
  partner: number;
  name: string;
  good: string;
  amount: number;
  price: number;
  map: number;
  meeting: { x: number; y: number; z?: number };
  until: number;
  state: 'accepted' | 'ready' | 'completed' | 'cancelled';
  announcedAt?: number;
  reason?: string;
}
export interface PersonalGoal {
  id: string;
  kind: 'supplies' | 'mount' | 'equipment' | 'skill' | 'home' | 'supply-order';
  description: string;
  target: number;
  progress: number;
  startedAt: number;
  state: 'active' | 'completed' | 'blocked';
}
export interface StrategyPlace {
  map: number;
  x: number;
  y: number;
  activity: string;
  attempts: number;
  productive: number;
  setbacks: number;
  skillGain: number;
  updatedAt: number;
}
export interface ResidentMemory {
  version: 1;
  episodes: Episode[];
  partners: Record<string, { name: string; trust: number; conversations: number; lastAt: number }>;
  commitment?: Commitment;
  orders: WorkOrder[];
  request?: {
    good: string;
    amount: number;
    price: number;
    map: number;
    meeting: { x: number; y: number };
    until: number;
  };
  pendingOrder?: { partner: number; name: string; good: string; amount: number; price: number; until: number };
  goals: PersonalGoal[];
  habits?: { sessionUntil: number; offlineUntil: number; style: 'plain' | 'friendly' | 'reserved' };
  strategies: StrategyPlace[];
  lastCompanionOfferAt?: number;
  economy?: { lootedGold: number; soldGold: number; bankedGold: number };
  favorite?: { map: number; x: number; y: number; activity: string };
}

export interface SharedPlan {
  stageAt?: number;
  stage: 'prepare' | 'hunt' | 'settle' | 'restock' | 'return' | 'complete';
  ground: { x: number; y: number };
  groundName: string;
  meeting: { x: number; y: number };
  startedAt: number;
  killsAtStart: number;
  heldUntil?: number;
  ignore?: { serial: number; until: number };
  returnStep: boolean;
}
