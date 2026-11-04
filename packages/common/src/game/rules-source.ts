// Reading ServUO's C# for the rules build (build-rules.ts, rules-tables.ts).
// C# without its comments (code left disabled in a comment is no rule), strings kept whole.
export const uncommented = (text: string) =>
  text.replace(/("(?:[^"\\\n]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_match, string) => string ?? '');
export const hex = (text: string) => [...text.matchAll(/0x[0-9a-f]+/gi)].map((m) => Number(m[0]));
// A class's whole body, nested classes included, by matching braces (strings skipped).
export function bodyAt(text: string, from: number) {
  let depth = 0;
  let open = -1;
  for (let i = text.indexOf('{', from); i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = text.indexOf('"', i + 1);
      if (i < 0) break;
      continue;
    }
    if (c === '{') {
      depth++;
      if (open < 0) open = i;
    } else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}
