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
  // Server-made markup (the character scene drawn from the client's art), with its own style.
  | { kind: 'html'; html: string; style?: string };

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
