import type { DecisionTrace } from './decisions';
import type { Checkpoint } from './store';
import { checkpointEvent, traceContext } from './telemetry';

const seen = new WeakMap<DecisionTrace, string>();
const origins = new WeakMap<DecisionTrace, { intentId?: string; traceId?: string; parentId?: string }>();
export function recordDecisions(checkpoint: Checkpoint) {
  for (const trace of checkpoint.decisions?.history ?? []) {
    const signature = `${trace.source}:${trace.selected}:${trace.execution.status}:${trace.reason}`;
    if (seen.get(trace) === signature) continue;
    seen.set(trace, signature);
    if (!origins.has(trace))
      origins.set(trace, {
        intentId: traceContext()?.intentId,
        traceId: traceContext()?.traceId,
        parentId: traceContext()?.actionId
      });
    const status = trace.execution.status;
    const result =
      status === 'failed' || status === 'interrupted' || status === 'completed'
        ? status
        : trace.source === 'pending'
          ? 'proposed'
          : status === 'not-run'
            ? 'unconfirmed'
            : 'observed';
    checkpointEvent(
      checkpoint,
      'decision',
      'decision',
      result,
      {
        kind: trace.kind,
        decisionAt: trace.at,
        state: trace.state,
        baseline: trace.baseline,
        configHash: trace.configHash,
        requestedModel: trace.requestedModel,
        resolvedModel: trace.resolvedModel,
        selected: trace.selected,
        candidates: trace.candidates,
        reason: trace.reason,
        source: trace.source,
        observationRevision: trace.observationRevision,
        latencyMs: trace.latencyMs,
        confidence: trace.confidence,
        execution: trace.execution,
        requestHash: trace.requestHash
      },
      { ...origins.get(trace), decisionId: trace.id }
    );
  }
}
