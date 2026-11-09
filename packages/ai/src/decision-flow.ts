// The path one decision took, step by step, for the analyzer's flowchart (packages/analyze/src/
// decisions.ts): every check with its outcome, every fork with all its options and their weights,
// and which way it went. The decision code fills it in as it runs; the coordinator adds its own
// steps (whether a model was asked, what it answered) and logs it with the question.
// The action arbiter's preemptions (combat over work, escape over everything) are not traced:
// they fire far more often than deliberate choices and would need sampling first.
export interface FlowOption {
  id: string;
  weight?: number;
  // The factors multiplied or added into the weight, by name.
  factors?: Record<string, number>;
  note?: string;
  // What the option means, as offered to the model.
  about?: string;
}
export type FlowStep =
  // `more` is longer text shown folded, such as the question a model was sent.
  | { kind: 'check'; label: string; passed: boolean; detail?: string; exit?: string; more?: string }
  | { kind: 'fork'; label: string; options: FlowOption[]; taken: string; detail?: string }
  | { kind: 'note'; label: string; detail?: string };

const round = (n: number) => Number(n.toPrecision(4));

export class DecisionFlow {
  readonly steps: FlowStep[] = [];
  // A statement tested on the way. `exit` names where the decision went when it ended here.
  check(label: string, passed: boolean, detail?: string, exit?: string, more?: string): boolean {
    this.steps.push({
      kind: 'check',
      label,
      passed,
      ...(detail ? { detail } : {}),
      ...(exit ? { exit } : {}),
      ...(more ? { more } : {})
    });
    return passed;
  }
  fork(label: string, options: FlowOption[], taken: string, detail?: string): string {
    this.steps.push({
      kind: 'fork',
      label,
      options: options.map((o) => ({
        ...o,
        ...(o.weight === undefined ? {} : { weight: round(o.weight) }),
        ...(o.factors ? { factors: Object.fromEntries(Object.entries(o.factors).map(([k, v]) => [k, round(v)])) } : {})
      })),
      taken,
      ...(detail ? { detail } : {})
    });
    return taken;
  }
  note(label: string, detail?: string) {
    this.steps.push({ kind: 'note', label, ...(detail ? { detail } : {}) });
  }
}

// Why the coordinator did or did not ask a model, in words.
export const askReasons: Record<string, string> = {
  'local-provider': 'No model is configured; the local rules decide',
  'single-legal-action': 'Only one option is legal, so there is nothing to ask',
  'provider-underperforms-baseline': "The model's past picks of this kind did worse than the local rules",
  'observations-changed': 'The situation changed before asking',
  'provider-disabled': 'The model refused the credentials earlier this run',
  'provider-busy': "Another of this resident's questions is still waiting for an answer",
  'request-too-large': 'The question is larger than the request size limit',
  'run-budget': 'This run has used up its requests',
  'daily-request-budget': "This resident has used up today's requests",
  'daily-cost-budget': "This resident has used up today's token allowance",
  'optional-kind-budget': "Optional questions have used up their share of today's tokens",
  'population-cost-budget': 'The population is ahead of its paced daily token allowance',
  cooldown: 'Too soon after the previous question'
};
