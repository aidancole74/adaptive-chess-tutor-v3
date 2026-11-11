/** Minimal PGN helpers for the Lichess dump format (one header per line, movetext on one line). */

export interface RawGame {
  headers: Record<string, string>;
  movetext: string;
  /** Raw PGN text (headers, blank line, movetext); only filled when `keepRaw` is requested. */
  raw: string | null;
}

const HEADER_RE = /^\[(\w+) "(.*)"\]\s*$/;

/** Groups dump lines into games. `keepRaw()` is polled per game so the caller can stop paying for raw text. */
export async function* gamesFromLines(lines: AsyncIterable<string>, keepRaw: () => boolean = () => false): AsyncGenerator<RawGame> {
  let headers: Record<string, string> = {};
  let rawLines: string[] | null = keepRaw() ? [] : null;
  let sawHeader = false;
  for await (const line of lines) {
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 91 /* [ */) {
      const m = HEADER_RE.exec(line);
      if (m) headers[m[1] as string] = m[2] as string;
      sawHeader = true;
      rawLines?.push(line);
      continue;
    }
    if (!sawHeader) continue; // movetext without headers (stream started mid-game)
    yield { headers, movetext: line, raw: rawLines ? `${rawLines.join('\n')}\n\n${line}\n` : null };
    headers = {};
    sawHeader = false;
    rawLines = keepRaw() ? [] : null;
  }
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/**
 * SAN tokens of a movetext line: comments `{...}`, variations `(...)`, NAGs `$n`, move numbers and
 * annotation glyphs (`!?`) are stripped. Stops after `max` plies or at the result token.
 */
export function sanTokens(movetext: string, max = Infinity): string[] {
  const out: string[] = [];
  const n = movetext.length;
  let i = 0;
  while (i < n && out.length < max) {
    const c = movetext.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      i++;
      continue;
    }
    if (c === 123 /* { */) {
      const j = movetext.indexOf('}', i + 1);
      if (j < 0) break;
      i = j + 1;
      continue;
    }
    if (c === 40 /* ( */) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const d = movetext.charCodeAt(i);
        if (d === 40) depth++;
        else if (d === 41) depth--;
        else if (d === 123) {
          const j = movetext.indexOf('}', i + 1);
          if (j < 0) return out;
          i = j;
        }
        i++;
      }
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const d = movetext.charCodeAt(j);
      if (d === 32 || d === 9 || d === 13 || d === 10 || d === 123 || d === 40) break;
      j++;
    }
    let tok = movetext.slice(i, j);
    i = j;
    if (c === 36 /* $ */) continue;
    if (RESULTS.has(tok)) break;
    if (c >= 48 && c <= 57) {
      // move number, possibly glued to the move ("12.Nf3" / "12...Nf6")
      const dot = tok.lastIndexOf('.');
      if (dot < 0) continue;
      tok = tok.slice(dot + 1);
      if (tok.length === 0) continue;
    }
    let end = tok.length;
    while (end > 0) {
      const d = tok.charCodeAt(end - 1);
      if (d === 33 || d === 63) end--;
      else break;
    }
    if (end === 0) continue;
    out.push(end === tok.length ? tok : tok.slice(0, end));
  }
  return out;
}

/** Lichess TimeControl header "base+inc" in seconds; null for correspondence ("-") or malformed values. */
export function parseTimeControl(tc: string | undefined): { base: number; inc: number; estimated: number } | null {
  if (!tc) return null;
  const m = /^(\d+)\+(\d+)$/.exec(tc);
  if (!m) return null;
  const base = Number(m[1]);
  const inc = Number(m[2]);
  return { base, inc, estimated: base + 40 * inc };
}

export function gameIdOf(site: string | undefined): string {
  if (!site) return '';
  const i = site.lastIndexOf('/');
  return i >= 0 ? site.slice(i + 1) : site;
}
