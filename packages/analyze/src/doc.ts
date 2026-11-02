// What the analyzer's API sends for a page: a title and a list of blocks the web app renders
// (web/blocks.tsx). Pages describe their content; how it looks is the app's business.
export type Cell =
  | string
  | number
  | null
  | {
      text: string;
      // An analyzer page (/mobile/1, /replay/2) or nothing.
      href?: string;
      // What the column sorts by when it differs from the text.
      sort?: string | number;
      // A quieter second part, such as a serial in hex.
      muted?: string;
      tone?: 'error' | 'good';
      // A small picture before the text, such as an item's art.
      icon?: string;
    };

export type Block =
  | { kind: 'note'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'fields'; rows: [string, Cell][] }
  | {
      kind: 'table';
      head: string[];
      rows: Cell[][];
      // Columns that hold numbers: right-aligned, sorted as numbers.
      numeric?: number[];
      // A filter box over the first column, and click-to-sort headings.
      interactive?: boolean;
      empty?: string;
    }
  | { kind: 'pre'; text: string }
  // A picture drawn from the client's art, such as an item's.
  | { kind: 'art'; src: string; alt: string }
  // Server-made markup (the character scene drawn from the client's art), with its own style.
  | { kind: 'html'; html: string; style?: string }
  // Headline numbers, each with how it moved since the previous pull.
  | { kind: 'stats'; items: Stat[] }
  // One measure over time (epoch ms, value), with moments worth marking (stalls).
  | { kind: 'line'; label: string; points: [number, number][]; marks?: { at: number; label: string }[] }
  // How a whole splits into parts, in a fixed order so each part keeps its colour.
  | { kind: 'shares'; label: string; parts: { label: string; value: number }[] }
  // A small world map with dots, linking to the full map.
  | { kind: 'minimap'; map: number; width: number; height: number; drawn: boolean; dots: Dot[] };

export interface Stat {
  label: string;
  value: string;
  // The change since the previous pull, toned by whether it is good news.
  delta?: { text: string; tone: 'good' | 'error' | 'muted' };
  note?: string;
  href?: string;
}

export interface Dot {
  x: number;
  y: number;
  label: string;
  href: string;
}

export interface Doc {
  title: string;
  subtitle?: Cell[];
  blocks: Block[];
}

export const link = (text: string, href: string, muted?: string): Cell => ({ text, href, muted });
export const num = (n: number, digits = 0): Cell => ({
  text: n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  sort: n
});
export const noDatabase = (title: string): Doc => ({
  title,
  blocks: [{ kind: 'note', text: 'This pull has no resident database.' }]
});
