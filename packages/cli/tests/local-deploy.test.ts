import { expect, test } from 'bun:test';

import { createConfig } from '@gemwright/server/config';

import { localCompose } from '../src/local-deploy';

test('the local project names its services after the parts and keeps data in named volumes', () => {
  const config = createConfig({ client: { version: '7.0.117.0' }, name: 'Local $test' });
  const compose = localCompose(config, {
    emulator: 'servuo',
    parts: ['server', 'client', 'ai'],
    aiPatched: true,
    serverPort: 2600,
    clientPort: 8080
  });
  const services = compose.services as Record<string, { ports?: string[]; environment: Record<string, string> }>;
  expect(Object.keys(services)).toEqual(['server', 'client', 'ai']);
  expect(Object.keys(compose.volumes)).toEqual(['server-data', 'ai-data']);
  expect(services.server?.ports).toEqual(['127.0.0.1:2600:2593/tcp']);
  expect(services.server?.environment).toMatchObject({
    GEMWRIGHT_PUBLIC_HOST: '127.0.0.1',
    GEMWRIGHT_PUBLIC_PORT: '2600',
    GEMWRIGHT_TRUSTED_HOSTS: 'ai'
  });
  expect(services.client?.ports).toEqual(['127.0.0.1:8080:3000/tcp']);
  expect(services.client?.environment).toMatchObject({
    UO_HOST: 'server',
    UO_PORT: '2593',
    SERVER_NAME: 'Local $$test'
  });
  expect(services.ai?.environment.UO_HOST).toBe('server');
});
