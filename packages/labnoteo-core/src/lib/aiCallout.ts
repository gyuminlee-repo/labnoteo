/**
 * The `> [!note] AI …` callouts this plugin inserts (#150): the model's
 * words, not the researcher's record. Readers that take a note as the
 * researcher's own — result summaries, sample usages — leave them out.
 */

/** First line of an AI answer this plugin inserted. */
const AI_CALLOUT_RE = /^>\s*\[!\w+\]\s*AI\b/i;

/**
 * Which lines of `lines` belong to an AI callout: its header line and the
 * `>` lines after it.
 */
function aiCalloutLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let inCallout = false;
  for (const line of lines) {
    if (inCallout && !line.trimStart().startsWith('>')) inCallout = false;
    if (!inCallout && AI_CALLOUT_RE.test(line.trimStart())) inCallout = true;
    out.push(inCallout);
  }
  return out;
}

/**
 * `md` without the `> [!note] AI …` callouts this plugin inserts, so a second
 * run does not read the first answer as a result.
 */
export function stripAiCallouts(md: string): string {
  const lines = md.split(/\r?\n/);
  const ai = aiCalloutLines(lines);
  return lines.filter((_, i) => !ai[i]).join('\n');
}

/**
 * `text` with every character of its AI callouts but line breaks turned into
 * spaces (#318), so offsets and line numbers stay put while a sample
 * reference the model copied there no longer reads as a usage.
 */
export function maskAiCallouts(text: string): string {
  const lines = text.split('\n');
  const ai = aiCalloutLines(lines.map(l => l.replace(/\r$/, '')));
  if (!ai.includes(true)) return text;
  return lines.map((line, i) => (ai[i] ? line.replace(/[^\r]/g, ' ') : line)).join('\n');
}
