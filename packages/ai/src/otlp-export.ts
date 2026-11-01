import { type AnyValueMap, type Logger, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

import { version } from '../package.json';
import type { TelemetryEvent } from './telemetry-schema';

// Optional OpenTelemetry export of the service's log lines: off unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set, which the exporter reads together with OTEL_EXPORTER_OTLP_HEADERS. Export is best effort:
// a full queue drops records, a failing backend is retried in the background without reaching the
// residents, and the journal stays the record.
const SHUTDOWN_MS = 3000;
const severity = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR
};
let provider: LoggerProvider | undefined;
let logger: Logger | undefined;

export function startExport() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || provider) return;
  provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'gemwright-ai',
      'service.version': version,
      'deployment.id': process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'
    }),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
  });
  logger = provider.getLogger('gemwright-ai');
}

export function exportEvent(event: TelemetryEvent) {
  if (!logger) return;
  const { message, level, at, ...fields } = event;
  logger.emit({
    timestamp: new Date(at),
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    // Event fields are JSON values (details already redacted), which OTLP carries as nested maps.
    attributes: Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== null && value !== undefined)
    ) as AnyValueMap
  });
}

// What is still queued gets a short chance to leave; a dead backend never holds up a restart.
export async function stopExport() {
  if (provider) await Promise.race([provider.shutdown(), Bun.sleep(SHUTDOWN_MS)]);
}
