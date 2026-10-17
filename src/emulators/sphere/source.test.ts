import { expect, test } from 'bun:test';

import { resolveLatestSphereSources, sphereSources } from './source';

test('Sphere resolves server and scripts independently and fetches fresh revisions each time', async () => {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return Response.json({ sha: String(calls.length).repeat(40) });
  };
  const first = await resolveLatestSphereSources(fetcher);
  expect(first).toEqual({
    server: { ...sphereSources.server, revision: '1'.repeat(40) },
    scripts: { ...sphereSources.scripts, revision: '2'.repeat(40) }
  });
  const second = await resolveLatestSphereSources(fetcher);
  expect(second.server.revision).toBe('3'.repeat(40));
  expect(second.scripts.revision).toBe('4'.repeat(40));
  expect(calls).toEqual([
    'https://api.github.com/repos/Sphereserver/Source/commits/master',
    'https://api.github.com/repos/Sphereserver/Scripts/commits/master',
    'https://api.github.com/repos/Sphereserver/Source/commits/master',
    'https://api.github.com/repos/Sphereserver/Scripts/commits/master'
  ]);
});

test('Sphere rejects the source pair if either repository cannot be resolved', async () => {
  for (const repository of ['Source', 'Scripts']) {
    await expect(
      resolveLatestSphereSources(async (url) =>
        url.includes(`/${repository}/`) ? new Response('', { status: 503 }) : Response.json({ sha: 'a'.repeat(40) })
      )
    ).rejects.toThrow(`Sphere ${repository} master revision`);
  }
});

test('Sphere reports network and malformed revision failures without a fallback', async () => {
  await expect(
    resolveLatestSphereSources(async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
  for (const value of [null, {}, { sha: 'main' }, { sha: 42 }]) {
    await expect(resolveLatestSphereSources(async () => Response.json(value))).rejects.toThrow(
      'invalid commit revision'
    );
  }
});
