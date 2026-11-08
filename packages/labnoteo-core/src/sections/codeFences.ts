/**
 * Code fences as every writer that deletes or replaces note text reads them:
 * only a fence that is closed is code. An opener that is never closed is a
 * line of text, so it cannot hide the headings below it and make a section
 * run to the end of the note (and a replacement delete what follows).
 */

/** An open code fence: which character opened it, and how long the run was. */
export interface OpenFence {
  char: string;
  length: number;
}

/** A fence line: up to 3 leading spaces, then a run of 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Advance code-fence state across one line.
 *
 * Per CommonMark a fence is closed only by a run of the SAME character that is
 * at least as long as the opener, and a closing fence carries no info string.
 * Tracking that matters: a plain boolean toggle read the ``` inside a `~~~`
 * block as a close, then read the real `~~~` as an open — and from there every
 * heading in the rest of the document looked like it was inside code, so the
 * section body ran to EOF and replacing it deleted every following section.
 * Showing fenced Markdown inside a fenced example is a normal thing to write in
 * a protocol note.
 */
export function stepFence(line: string, open: OpenFence | null): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) return open;

  const run = match[1];
  const afterRun = line.slice(line.indexOf(run) + run.length);
  // CommonMark: a backtick fence's info string has no backtick (```` ```a``` ```` is inline code).
  if (open === null) return run[0] === '`' && afterRun.includes('`') ? null : { char: run[0], length: run.length };

  const closes = run[0] === open.char && run.length >= open.length && afterRun.trim() === '';
  return closes ? null : open;
}

/**
 * `[opener, closer]` line pairs of the closed fences of `lines`, each line
 * read through `read` first, in one linear pass. An opener that is never
 * closed is not a fence, and the lines after it are read as before.
 */
export function closedFenceSpans(lines: readonly string[], read: (line: string) => string = line => line): [number, number][] {
  const n = lines.length;
  const openers: (OpenFence | null)[] = lines.map(line => stepFence(read(line), null));
  // below[char]: the closing lines below that no nearer one is as long as, farthest first, so
  // their run lengths fall: an opener's closer is the last one at least as long as it is.
  const below = new Map<string, { line: number; length: number }[]>();
  const closeAfter = new Array<number>(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const open = openers[i];
    const list = open ? below.get(open.char) : undefined;
    if (open && list) {
      let lo = 0, hi = list.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].length >= open.length) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at !== -1) closeAfter[i] = list[at].line;
    }
    // A bare run (nothing after it) closes any open fence of its character no longer than itself.
    if (open && stepFence(read(lines[i]), open) === null) {
      const runs = list ?? [];
      while (runs.length > 0 && runs[runs.length - 1].length <= open.length) runs.pop();
      runs.push({ line: i, length: open.length });
      below.set(open.char, runs);
    }
  }
  const spans: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (openers[i] && closeAfter[i] !== -1) {
      spans.push([i, closeAfter[i]]);
      i = closeAfter[i] + 1;
    } else i++;
  }
  return spans;
}

/** Whether each line of `lines` lies in a closed fence ({@link closedFenceSpans}), its fence lines included. */
export function closedFencedLines(lines: readonly string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  for (const [open, close] of closedFenceSpans(lines)) inCode.fill(true, open, close + 1);
  return inCode;
}

/**
 * Code lines as a reader closer to CommonMark has them, for writers that only
 * want to keep code out of an edit: the front matter is no Markdown; a fence
 * runs to its closer or the end of the note; a fence right after a list
 * marker (`- ```md`) holds the lines indented by the marker's width and ends
 * at its closer or a line indented less. Not read: block quotes, nested
 * lists, indented code.
 */
/**
 * Whether any line could open a fence at all (a run of three backticks or tildes anywhere in
 * it): without one, every fence reading here reads no code, so a caller may skip them.
 */
export function mayHaveFences(lines: readonly string[]): boolean {
  return lines.some(line => line.includes('```') || line.includes('~~~'));
}

export function markdownCodeLines(lines: readonly string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close > 0) i = close + 1;
  }
  let open: OpenFence | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      out[i] = true;
      open = stepFence(line, open);
      continue;
    }
    const list = /^( {0,3}(?:[-*+]|\d{1,9}[.)]) +)(`{3,}|~{3,})(.*)$/.exec(line);
    if (list && !(list[2][0] === '`' && list[3].includes('`'))) {
      const width = list[1].length;
      out[i] = true;
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k];
        if (l.trim() !== '' && !l.startsWith(' '.repeat(width))) break;
        out[k] = true;
        i = k;
        const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l.slice(Math.min(width, l.length)));
        if (c && c[1][0] === list[2][0] && c[1].length >= list[2].length) break;
      }
      continue;
    }
    open = stepFence(line, null);
    if (open) out[i] = true;
  }
  return out;
}
