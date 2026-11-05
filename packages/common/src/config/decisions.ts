export interface RemoteDecisionSettings {
  provider: 'jev' | 'clef';
  model: string;
  credentialEnv?: string;
}

export type DecisionProviderSettings = RemoteDecisionSettings | { provider: 'local' };
export type DecisionSettings = 'local' | 'jev' | 'clef' | DecisionProviderSettings[];

const defaults = {
  jev: { provider: 'jev', model: 'jev-1.13.0', credentialEnv: 'TYPESAFE_API_KEY' },
  clef: { provider: 'clef', model: 'clef-flash', credentialEnv: 'CLOUDFLARE_API_TOKEN' }
} satisfies Record<string, RemoteDecisionSettings>;
const models = {
  jev: ['jev-1.13.0', 'jev-1.14.0'],
  clef: ['clef', 'clef-flash', 'clef-omni']
};

export function decisionProviders(value: unknown = 'local'): DecisionProviderSettings[] {
  if (value === 'local') return [{ provider: 'local' }];
  if (value === 'jev') return [{ ...defaults.jev }, { provider: 'local' }];
  if (value === 'clef') return [{ ...defaults.clef }, { ...defaults.jev }, { provider: 'local' }];
  const fail = () => {
    throw new Error(
      'Invalid ai.decisions: use local, jev, clef, or an ordered provider list ending in local; remote entries require provider and model.'
    );
  };
  if (!Array.isArray(value) || !value.length || value.length > 3) return fail();
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail();
    const provider = entry.provider;
    if (!['local', 'jev', 'clef'].includes(provider) || seen.has(provider)) return fail();
    seen.add(provider);
    if (provider === 'local') {
      if (Object.keys(entry).length !== 1 || entry !== value.at(-1)) return fail();
    } else {
      if (
        Object.keys(entry).some((key) => !['provider', 'model', 'credentialEnv'].includes(key)) ||
        !models[provider as keyof typeof models].includes(entry.model) ||
        (entry.credentialEnv !== undefined &&
          (typeof entry.credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(entry.credentialEnv)))
      )
        return fail();
    }
  }
  if (value.at(-1)?.provider !== 'local') return fail();
  return value.map((entry) =>
    entry.provider === 'local'
      ? { ...entry }
      : {
          ...entry,
          credentialEnv: entry.credentialEnv ?? defaults[entry.provider as keyof typeof defaults].credentialEnv
        }
  );
}
