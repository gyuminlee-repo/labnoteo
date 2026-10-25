/**
 * Where a note's body starts: the front matter's closing line and the first
 * heading. Shared by the insert planners that must not put content in the front
 * matter or above the title (#50, #63).
 */
export interface DocumentHead {
  /** Line index of the closing `---`, or -1 when there is no (closed) front matter. */
  fmEndLine: number;
  /** Line index of the first heading outside front matter and code, or -1. */
  firstHeadingLine: number;
  /** Every heading line outside front matter and code. */
  headingLines: Set<number>;
}

export function scanDocumentHead(lines: readonly string[]): DocumentHead {
  // Front matter: first line `---`, closed by the next `---`.
  let fmEndLine = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEndLine = i;
        break;
      }
    }
  }

  // Ignore `#` lines inside fenced code blocks and inside the front matter
  // (YAML comments look like headings).
  const headingLines = new Set<number>();
  let firstHeadingLine = -1;
  let inFence = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    if (fmEndLine !== -1 && i <= fmEndLine) continue;
    const trimmed = lines[i].trimStart();
    const fence = /^(```+|~~~+)/.exec(trimmed);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      headingLines.add(i);
      if (firstHeadingLine === -1) firstHeadingLine = i;
    }
  }

  return { fmEndLine, firstHeadingLine, headingLines };
}

/**
 * Whether `offset` falls inside the note's front matter, its `---` lines
 * included. An unclosed `---` block is not front matter.
 */
export function isInFrontMatter(doc: string, offset: number): boolean {
  const { fmEndLine } = scanDocumentHead(doc.split('\n'));
  return fmEndLine !== -1 && doc.slice(0, offset).split('\n').length - 1 <= fmEndLine;
}

/** {@link isBeforeBody} for an offset into `doc`. */
export function isOffsetBeforeBody(doc: string, offset: number): boolean {
  const lines = doc.split('\n');
  const lineStarts: number[] = [];
  let acc = 0;
  for (const line of lines) {
    lineStarts.push(acc);
    acc += line.length + 1;
  }
  const cursorLine = doc.slice(0, offset).split('\n').length - 1;
  return isBeforeBody(scanDocumentHead(lines), lineStarts, cursorLine, offset);
}

/**
 * Whether an insert at `pos` would land in the front matter or above the title:
 * the cursor is inside the front matter, or at/before the start of the first
 * heading line. Without any heading only the front matter counts.
 */
export function isBeforeBody(
  head: DocumentHead,
  lineStarts: readonly number[],
  cursorLine: number,
  pos: number
): boolean {
  const inFrontMatter = head.fmEndLine !== -1 && cursorLine <= head.fmEndLine;
  const atOrAboveFirstHeading =
    head.firstHeadingLine !== -1 && pos <= lineStarts[head.firstHeadingLine];
  return inFrontMatter || atOrAboveFirstHeading;
}
