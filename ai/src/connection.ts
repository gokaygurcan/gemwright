import { CLIENT_VERSION } from './protocol/packets';

export interface ConnectionConfig {
  schemaVersion: 1;
  shardId: string;
  emulator: 'servuo';
  profile: 'classic-7.0.45.1';
  host: string;
  port: number;
  serverIndex: number;
  timeoutMs: number;
}

export function validateConnection(value: unknown): ConnectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Connection configuration must be an object');
  const c = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'shardId', 'emulator', 'profile', 'host', 'port', 'serverIndex', 'timeoutMs'];
  if (Object.keys(c).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(c, k)))
    throw new Error('Connection configuration contains missing or unknown fields');
  if (c.schemaVersion !== 1 || c.emulator !== 'servuo' || c.profile !== `classic-${CLIENT_VERSION}`)
    throw new Error('Unsupported emulator/profile; only the tested unencrypted ServUO classic profile is available');
  if (typeof c.shardId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.shardId))
    throw new Error('Invalid connection shard ID');
  if (typeof c.host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(c.host) || c.host.length > 253)
    throw new Error('Connection host must be an IPv4 address or DNS name');
  for (const [key, min, max] of [
    ['port', 1, 65535],
    ['serverIndex', 0, 65535],
    ['timeoutMs', 1000, 120000]
  ] as const) {
    if (typeof c[key] !== 'number' || !Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error(`Invalid connection ${key}`);
  }
  return c as unknown as ConnectionConfig;
}
