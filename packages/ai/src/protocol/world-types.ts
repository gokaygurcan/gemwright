export interface Position {
  x: number;
  y: number;
  z: number;
  direction: number;
}
export interface Entity {
  serial: number;
  kind: 'mobile' | 'item';
  graphic: number;
  hue?: number;
  name?: string;
  position?: Position;
  parent?: number;
  layer?: number;
  amount?: number;
  containerX?: number;
  flags?: number;
  notoriety?: number;
  hits?: number;
  maxHits?: number;
  healthAt?: number;
  properties?: { cliloc: number; arguments: string }[];
}
export interface JournalEntry {
  at: string;
  serial: number;
  name: string;
  text?: string;
  type?: number; // speech: 0 regular, 2 emote, 6 label
  party?: boolean; // party chat, heard by members wherever they are
  cliloc?: number;
  arguments?: string;
}
