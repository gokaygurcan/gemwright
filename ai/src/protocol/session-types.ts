import type { Appearance } from '../appearance';

export interface Credentials {
  username: string;
  password: string;
}
export type SessionPhase = 'offline' | 'login' | 'relay' | 'characters' | 'entering' | 'ready' | 'failed';
export interface CharacterRequest {
  slot: number;
  create?: {
    name: string;
    city: string;
    skills: {
      id: number;
      value: number;
    }[];
    appearance?: Appearance;
  };
}
