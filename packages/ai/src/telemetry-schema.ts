export type EventResult =
  | 'started'
  | 'proposed'
  | 'authorized'
  | 'sent'
  | 'dispatched'
  | 'observed'
  | 'completed'
  | 'failed'
  | 'unconfirmed'
  | 'interrupted'
  | 'timed-out';
export interface TelemetryEvent {
  schemaVersion: 2;
  id: string;
  at: string;
  runId: string;
  deploymentId: string | null;
  sequence: number;
  component: string;
  message: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: string;
  result: EventResult;
  residentId: string | null;
  name: string | null;
  sessionId: string | null;
  traceId: string;
  intentId?: string;
  decisionId?: string;
  actionId?: string;
  parentId?: string;
  position: { map: number | null; x: number; y: number; z: number } | null;
  details: Record<string, unknown>;
}
export interface TraceContext {
  actor?: () => Pick<TelemetryEvent, 'residentId' | 'name' | 'sessionId' | 'position'>;
  traceId?: string;
  intentId?: string;
  decisionId?: string;
  actionId?: string;
  parentId?: string;
}

const sensitive =
  /^(?:password|passwd|secret|authorization|cookie|token|api[_-]?key|credentials|accountRef|username)$/i;
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return '[depth-limit]';
  if (value instanceof Error) return { name: value.name, message: String(redact(value.message, depth + 1, seen)) };
  if (typeof value === 'string')
    return value
      .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
      .replace(/\b(password|api[_-]?key|secret|token)=([^\s&]+)/gi, '$1=[redacted]');
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive.test(key) ? '[redacted]' : redact(item, depth + 1, seen)
      ])
    );
  } finally {
    seen.delete(value);
  }
}
