// What the lab (engine.ts, web/lab.tsx) passes between page, server and worker: a decision's inputs
// and options, and a scenario of changes to make them again with. Anything left out is as it was.
export interface Scenario {
  // The AI's judgements (packages/ai tuning.ts).
  tuning?: Record<string, number>;
  traits?: Record<string, number>;
  // Its hits now (the most it has stays as it was).
  health?: number;
  position?: { x: number; y: number };
  // Gold it can spend.
  funds?: number;
  // What a mobile in view is taken for, by serial ('Brigand/Person').
  identities?: Record<string, string>;
  // What it believes of a kind at a spawner, by `x,y:Kind`.
  spawners?: Record<string, SpawnerBelief>;
  // What doing something is expected to bring, by what it learns it as ('attack Brigand').
  appraisals?: Record<string, { value?: number; seconds?: number }>;
  // A plan's chance of succeeding, by option id.
  chances?: Record<string, number>;
  // The encounter's answer to a question ('allows 49457', 'allowsKind Brigand').
  answers?: Record<string, boolean>;
  // Options the loop breaker blocks (true) or lets through (false), by option id.
  blocked?: Record<string, boolean>;
}

export interface SpawnerBelief {
  visits?: number;
  finds?: number;
  // Last seen empty.
  empty?: boolean;
  // Seconds since it last left it.
  leftAgo?: number;
}

export interface WeighedOption {
  id: string;
  key: string;
  // What it learns doing it as (the appraisal it is valued by).
  learn: string;
  value: number;
  seconds: number;
  rate: number;
  urgent: boolean;
  blocked: boolean;
}

export interface Appraisal {
  learn: string;
  // Tries it has of it.
  n: number;
  value: number;
  seconds: number;
}

export interface Sighting {
  serial: number;
  name: string;
  x?: number;
  y?: number;
  away?: number;
}

export interface Spawning {
  key: string;
  x: number;
  y: number;
  kind: string;
  walk: number;
  chance: number;
  share: number;
  max: number;
  delay: [number, number];
  visits: number;
  finds: number;
  empty: boolean;
  leftAgo?: number;
}

// One decision as weighed: everything it took in, every option it valued, and what it chose.
export interface Weighing {
  id: number;
  resident: string;
  name: string;
  kind: 'considered' | 'reconsidered';
  at: number;
  trigger: string;
  // The plan under way, for a second thought.
  plan?: string;
  tuning: Record<string, number>;
  traits: Record<string, number>;
  health: { current: number | null; max: number | null };
  position?: { x: number; y: number; z: number };
  funds: number;
  sightings: Sighting[];
  spawners: Spawning[];
  appraisals: Appraisal[];
  chances: Record<string, number>;
  answers: Record<string, boolean>;
  options: WeighedOption[];
  chose: string;
  digest: string;
  ms: number;
}

export interface LiveDecision {
  chose: string;
  digest?: string;
  options: { id: string; key: string; value: number; rate: number; seconds: number; blocked?: boolean }[];
}

export interface LabResponse {
  live: LiveDecision;
  // As made again with nothing changed, and with the scenario.
  original: Weighing;
  changed?: Weighing;
}

// A scenario over many decisions: each made again, as it was and changed, compared.
export interface SpanRequest {
  residents: string[];
  hours: number;
  // When the stretch ends (epoch ms): the history's newest event when not given.
  until?: number;
  scenario: Scenario;
}

export interface SpanChange {
  id: number;
  resident: string;
  at: number;
  kind: string;
  before: string;
  after: string;
}

export interface SpanResident {
  resident: string;
  name: string;
  total: number;
  done: number;
  changed: number;
  // Decisions in the stretch before its run's first kept mind: none of those can be made again.
  skipped: number;
  // How often each plan was chosen, as it was and changed.
  before: Record<string, number>;
  after: Record<string, number>;
  error?: string;
}

export interface SpanStatus {
  id: string;
  running: boolean;
  started: number;
  finished?: number;
  request: SpanRequest;
  residents: SpanResident[];
  changes: SpanChange[];
}
