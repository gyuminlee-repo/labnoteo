/**
 * Closed code fences of a README, for the two workflow paths that must not
 * touch a fenced example: deletion skips the lines inside one, and adding
 * moves an entry that would land inside one to just after it. Finding the
 * section, reading entries and reordering them do not look at fences, as in
 * v0.130.0, so a fence can only make these paths do less, never hide a line
 * they used to see.
 *
 * A line is inside when either reading puts it there: fences indented up to
 * three spaces ({@link stepFence} as is), or fences at any indent (the line
 * with its indent dropped, as under a list entry). An opener that is never
 * closed is not a fence. Each reading is one linear pass.
 */
import { stepFence, type OpenFence } from '../sections/sectionEdit';

/** `[opener, closer]` line pairs of the closed fences in one reading of `lines`. */
function fenceSpans(lines: readonly string[], read: (line: string) => string): [number, number][] {
  const n = lines.length;
  const openers: (OpenFence | null)[] = lines.map(line => stepFence(read(line), null));
  // nearest[char][length]: the first closing line below, for an opener of that run length or shorter.
  const nearest = new Map<string, number[]>();
  const closeAfter = new Array<number>(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const open = openers[i];
    if (open) closeAfter[i] = nearest.get(open.char)?.[open.length] ?? -1;
    // A bare run (nothing after it) closes any open fence of its character no longer than itself.
    if (open && stepFence(read(lines[i]), open) === null) {
      const byLength = nearest.get(open.char) ?? [];
      for (let len = 3; len <= open.length; len++) byLength[len] = i;
      nearest.set(open.char, byLength);
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

/** Closed fences of `lines` as `[opener, closer]` pairs, in either reading (they may overlap). */
export function readmeFenceSpans(lines: readonly string[]): [number, number][] {
  return [...fenceSpans(lines, line => line), ...fenceSpans(lines, line => line.trimStart())];
}

/** Whether each line lies in a closed fence of {@link readmeFenceSpans}, its fence lines included. */
export function readmeFencedLines(lines: readonly string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  for (const [open, close] of readmeFenceSpans(lines)) inCode.fill(true, open, close + 1);
  return inCode;
}

/**
 * `at` (a position before line `at`) in the section headed on line `header`,
 * moved out of every closed fence it falls inside: past the fence's closing
 * line, or, when that would pass `limit` (the end of the section, which a
 * fence may hide a heading in), before the fence's opening line instead. The
 * line then stays in the section, where reading finds it. A section whose
 * heading is itself in a fence is left as v0.130.0 reads it: `at` stays.
 */
export function positionOutsideFences(lines: readonly string[], at: number, header: number, limit = lines.length): number {
  const spans = readmeFenceSpans(lines);
  if (spans.some(([open, close]) => open < header && header <= close)) return at;
  const inside = (pos: number): [number, number][] => spans.filter(([open, close]) => open < pos && pos <= close);
  let after = at;
  for (let around = inside(after); around.length > 0; around = inside(after)) after = Math.max(...around.map(([, close]) => close + 1));
  if (after <= limit) return after;
  let before = at;
  for (let around = inside(before); around.length > 0; around = inside(before)) before = Math.min(...around.map(([open]) => open));
  return before;
}
