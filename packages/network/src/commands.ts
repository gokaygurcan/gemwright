import type { PlayerSession } from './session';

export type CommandResource = 'movement' | 'hands' | 'target' | 'inventory' | 'context' | 'trade' | 'speech' | 'gump';
export interface Command {
  name: string;
  args: readonly unknown[];
  resources: readonly CommandResource[];
  async: boolean;
  atomic: boolean;
  confirmed: boolean;
}
const definitions: Record<
  string,
  { resources: CommandResource[]; async?: boolean; atomic?: boolean; confirmed?: boolean }
> = {
  walk: { resources: ['movement', 'hands'], async: true, atomic: true, confirmed: true },
  use: { resources: ['hands', 'target'] },
  useSkill: { resources: ['hands', 'target'] },
  target: { resources: ['target'] },
  context: { resources: ['context'], async: true, confirmed: true },
  selectContext: { resources: ['context', 'target', 'hands'] },
  moveItem: { resources: ['inventory', 'hands'], async: true, atomic: true, confirmed: true },
  giveToMobile: { resources: ['inventory', 'hands'], async: true, atomic: true },
  dropAtFeet: { resources: ['inventory', 'hands'], async: true, atomic: true, confirmed: true },
  equipItem: { resources: ['inventory', 'hands'], async: true, atomic: true, confirmed: true },
  purchaseItem: { resources: ['inventory', 'hands'], async: true, atomic: true, confirmed: true },
  purchaseAnimal: { resources: ['inventory', 'hands'], async: true, atomic: true },
  sell: { resources: ['inventory', 'hands'], async: true, atomic: true, confirmed: true },
  attack: { resources: ['hands', 'target'], async: true, confirmed: true },
  setWarMode: { resources: ['hands'] },
  acceptTrade: { resources: ['trade', 'inventory'] },
  cancelTrade: { resources: ['trade'] },
  say: { resources: ['speech'] },
  guildSay: { resources: ['speech'] },
  party: { resources: ['speech', 'target'] },
  replyGump: { resources: ['gump', 'hands'] },
  answerPrompt: { resources: ['gump'] },
  openGuildMenu: { resources: ['gump'] },
  requestHelp: { resources: ['gump'] },
  toggleFlying: { resources: ['movement', 'hands'] },
  setLock: { resources: ['hands'] },
  refreshStatus: { resources: [], async: true, confirmed: true },
  refreshSkills: { resources: [], async: true, confirmed: true },
  inspect: { resources: [], async: true, confirmed: true },
  inspectProperties: { resources: [], async: true, confirmed: true }
};

// The wire layer describes commands; the injected runtime decides authorization and scheduling.
export function interceptCommands(
  session: PlayerSession,
  execute: (command: Command, invoke: () => unknown) => unknown
): () => void {
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  const wrappers = new Map<string, (...args: unknown[]) => unknown>();
  for (const [name, definition] of Object.entries(definitions)) {
    const original = Reflect.get(session, name);
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    const wrapper = (...args: unknown[]) =>
      execute(
        {
          name,
          args,
          resources: definition.resources,
          async: !!definition.async,
          atomic: !!definition.atomic,
          confirmed: !!definition.confirmed
        },
        () => Reflect.apply(original, session, args)
      );
    wrappers.set(name, wrapper);
    Reflect.set(session, name, wrapper);
  }
  return () => {
    for (const [name, original] of originals)
      if (Reflect.get(session, name) === wrappers.get(name)) Reflect.set(session, name, original);
  };
}
