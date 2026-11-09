import type { Block, FlowOption, FlowStep } from '../src/doc';

// One decision as a flowchart: a spine from the start node down to where it ended. A check shows
// its outcome and, failed, the branch it ended on; a fork shows every option with its weight, its
// share of the total and the factors behind it, the one taken marked.
type Flow = Extract<Block, { kind: 'flow' }>;
const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Number(n.toPrecision(3)).toString());

function Option({ option, taken, total }: { option: FlowOption; taken: boolean; total: number }) {
  const share =
    !option.note && option.weight !== undefined && total > 0 && option.weight > 0 ? option.weight / total : undefined;
  return (
    <li class={`flow-option${taken ? ' taken' : ''}${option.note ? ' excluded' : ''}`}>
      <div class="flow-option-head">
        <strong>{option.id}</strong>
        {option.weight !== undefined && <span>{fmt(option.weight)}</span>}
      </div>
      {share !== undefined && (
        <div class="flow-share" title={`${(share * 100).toFixed(1)}% of the total`}>
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
      {option.factors && (
        <dl class="flow-factors">
          {Object.entries(option.factors).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{fmt(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {option.about && <p class="muted">{option.about}</p>}
      {option.note && <p class="muted">{option.note}</p>}
    </li>
  );
}

function Step({ step }: { step: FlowStep }) {
  if (step.kind === 'note')
    return (
      <li class="flow-step flow-note">
        <span>{step.label}</span>
        {step.detail && <p class="muted">{step.detail}</p>}
      </li>
    );
  if (step.kind === 'check')
    return (
      <li class={`flow-step flow-check ${step.passed ? 'passed' : 'failed'}`}>
        <span class={step.passed ? 'tone-good' : 'tone-error'}>{step.passed ? 'yes' : 'no'}</span> {step.label}?
        {step.detail && <p class="muted">{step.detail}</p>}
        {step.more && (
          <details>
            <summary class="muted">The question</summary>
            <pre class="scroll">{step.more}</pre>
          </details>
        )}
        {step.exit && <p class="flow-exit">→ {step.exit}</p>}
      </li>
    );
  const total = step.options.reduce((n, o) => n + (!o.note && o.weight && o.weight > 0 ? o.weight : 0), 0);
  return (
    <li class="flow-step flow-fork">
      <span>{step.label}</span>
      {step.detail && <p class="muted">{step.detail}</p>}
      <ul class="flow-options">
        {step.options.map((o) => (
          <Option key={o.id} option={o} taken={o.id === step.taken} total={total} />
        ))}
      </ul>
      <p class="flow-exit">→ {step.taken}</p>
    </li>
  );
}

export function FlowChart({ block }: { block: Flow }) {
  return (
    <ol class="flow">
      <li class="flow-step flow-end">
        <strong>{block.start.label}</strong>
        {block.start.detail && <p class="muted">{block.start.detail}</p>}
      </li>
      {block.steps.map((s, i) => (
        <Step key={i} step={s} />
      ))}
      <li class="flow-step flow-end">
        <strong>{block.end.label}</strong>
        {block.end.detail && <p class="muted">{block.end.detail}</p>}
      </li>
    </ol>
  );
}
