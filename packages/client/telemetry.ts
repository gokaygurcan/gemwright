import { type AnyValueMap, type Logger, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

import { version } from './package.json';

// What the web service reports: one JSON line on stdout per event, and the same event as an
// OpenTelemetry log record when OTEL_EXPORTER_OTLP_ENDPOINT is set (with OTEL_EXPORTER_OTLP_HEADERS,
// read by the exporter). Events carry no addresses, account names or anything typed in game. Export
// is best effort: a full queue drops records and a failing backend never reaches the players.
const SHUTDOWN_MS = 3000;
let provider: LoggerProvider | undefined;
let logger: Logger | undefined;

export function startExport() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || provider) return;
  provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'gemwright-client',
      'service.version': version,
      'deployment.id': process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'
    }),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
  });
  logger = provider.getLogger('gemwright-client');
}

export function report(level: 'info' | 'error', message: string, details: Record<string, string | number> = {}) {
  const at = new Date();
  // Grouped like the AI's events, by component.
  const fields = { component: 'client', ...details };
  console.log(JSON.stringify({ at: at.toISOString(), level, message, ...fields }));
  logger?.emit({
    timestamp: at,
    severityNumber: level === 'error' ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: message,
    attributes: fields as AnyValueMap
  });
}

// What is still queued gets a short chance to leave; a dead backend never holds up a restart.
export async function stopExport() {
  if (provider) await Promise.race([provider.shutdown(), Bun.sleep(SHUTDOWN_MS)]);
}
