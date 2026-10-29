import { readFileSync } from 'node:fs';

export interface Monster {
  type: string;
  name: string | null;
  bodies: number[];
  hits: number[] | null;
  damage: number[] | null;
  magery: number;
  resist: number;
  fame: number;
  // Attacks on sight (its ServUO FightMode); combat skills, armor and the gold its loot packs carry.
  aggressive?: boolean;
  // ServUO AIType without the AI_ prefix (Melee, Mage, Archer, Berserk, Healer...) and FightMode.
  ai?: string | null;
  fightMode?: string;
  tactics?: number;
  wrestling?: number;
  armor?: number;
  gold?: number;
}

export const monsters: Monster[] = (
  JSON.parse(readFileSync(new URL('../catalogs/monsters.json', import.meta.url), 'utf8')) as { monsters: Monster[] }
).monsters;
