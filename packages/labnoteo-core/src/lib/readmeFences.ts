/**
 * Closed code fences of a README, for the two workflow paths that must not
 * touch a fenced example: deletion skips the lines inside one, and adding
 * moves an entry that would land inside one to just after it. Finding the
 * section, reading entries and reordering them do not look at fences, as in
 * v0.130.0, so a fence can only make these paths do less, never hide a line
 * they used to see.
 *
 * A line is inside when either reading puts it there: fences indented up to
 * three spaces ({@link closedFenceSpans} as is), or fences at any indent (the line
 * with its indent dropped, as under a list entry). An opener that is never
 * closed is not a fence. Each reading is one linear pass.
 */
import { closedFenceSpans } from '../sections/codeFences';

/** Closed fences of `lines` as `[opener, closer]` pairs, in either reading (they may overlap). */
export function readmeFenceSpans(lines: readonly string[]): [number, number][] {
  return [...closedFenceSpans(lines), ...closedFenceSpans(lines, line => line.trimStart())];
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
