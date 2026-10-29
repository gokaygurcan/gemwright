import { configureTelemetry, operational } from './telemetry';

let structured = false;
const original = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console)
};

// Service stdout and its durable journal share an envelope. CLI report output stays unchanged.
export function logToStdout() {
  if (structured) return;
  structured = true;
  configureTelemetry({ output: (line, level) => (level === 'error' ? original.error(line) : original.log(line)) });
  for (const [method, level] of [
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ] as const)
    console[method] = (...values: unknown[]) => {
      operational('runtime', level, values.length === 1 ? values[0] : values);
    };
}
export const info = (line: string, component = 'resident', details: Record<string, unknown> = {}) =>
  structured ? operational(component, 'info', line, details) : original.error(line);
export const error = (component: string, message: unknown) =>
  structured ? operational(component, 'error', message) : original.error(message);
export const logger = (component: string) => ({
  info: (message: string, details: Record<string, unknown> = {}) => info(message, component, details),
  error: (message: unknown) => error(component, message)
});
