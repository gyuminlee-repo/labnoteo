import {
  buildUnitOpTocLine,
  githubHeadingAnchor,
  appendUnitOpToWorkflowToc,
  rebuildUnitOpToc,
  refreshUnitOpTocEntries,
  addUnitOpTocEntry,
  locateInsertedUnitOpHeading,
  findUnitOpInsertOffset,
  minimalReplacement,
  shouldDeferTocSync,
  computeUnitOpSyncEdits,
  applyTextEdits,
  resolveGithubAnchor,
  type TextEdit,
} from '../sections/workflowSectionParser';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '../lib/unitOpTemplate';

/** A workflow note built the way the insert command builds it (block + TOC rebuild). */
function buildNote(ops: [string, string][]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, {
    noteId: 'LN-00000000',
  });
  ops.forEach(([opId, name]) => {
    const block = buildHwUnitOpMarkdown(
      { opId, opName: name, opDescription: `${name} step` },
      { experimenter: 'Dr. Kim', dateTime: '2026-09-29 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  });
  return md;
}

/**
 * Obsidian Outline drag: cut the heading's section (up to the next heading of
 * the same or higher level) and paste it before `beforeHeading` — or at the end
 * of the Related Unit Operations section when null.
 */
function outlineMove(md: string, heading: string, beforeHeading: string | null): string {
  const start = md.indexOf(heading);
  const re = /^#{1,3}\s/gm;
  re.lastIndex = start + 1;
  const next = re.exec(md);
  const end = next ? next.index : md.length;
  const chunk = md.slice(start, end);
  const rest = md.slice(0, start) + md.slice(end);
  const at = rest.indexOf(beforeHeading ?? '## Conclusions and Discussion');
  return rest.slice(0, at) + chunk + rest.slice(at);
}

const tidy = (md: string): string => applyTextEdits(md, computeUnitOpSyncEdits(md));
const collapseBlanks = (md: string): string => md.replace(/\n{3,}/g, '\n\n');
const tocOrder = (md: string): string[] =>
  [...md.matchAll(/^- \[(UHW\d+) /gm)].map(m => m[1]);

/** Non-blank line right before `offset`'s line. */
function prevNonBlank(md: string, offset: number): string {
  const lines = md.slice(0, offset).split('\n');
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') return lines[i];
  return '';
}

function expectTemplateShape(md: string): void {
  for (const m of md.matchAll(/^### \[/gm)) expect(prevNonBlank(md, m.index!)).toBe('---');
  expect(prevNonBlank(md, md.indexOf('## Conclusions and Discussion'))).not.toBe('---');
}

describe('buildUnitOpTocLine', () => {
  it('matches the serializeWorkflowMd slug/label format', () => {
    expect(buildUnitOpTocLine('UHW010', 'Centrifugation')).toBe(
      '- [UHW010 Centrifugation](#uhw010-centrifugation)'
    );
  });

  it('includes the alias in label and slug', () => {
    expect(buildUnitOpTocLine('USW010', 'Read Mapping', 'BWA')).toBe(
      '- [USW010 Read Mapping | BWA](#usw010-read-mapping-bwa)'
    );
  });

  it('strips punctuation from the slug', () => {
    expect(buildUnitOpTocLine('UHW020', 'PCR (95C)')).toBe(
      '- [UHW020 PCR (95C)](#uhw020-pcr-95c)'
    );
  });

  it('keeps a Korean alias in the anchor, as GitHub does', () => {
    expect(buildUnitOpTocLine('UHW180', 'Incubation', '계대 1일차')).toBe(
      '- [UHW180 Incubation | 계대 1일차](#uhw180-incubation-계대-1일차)'
    );
  });

  it('uses a given (de-duplicated) anchor', () => {
    expect(buildUnitOpTocLine('UHW180', 'Incubation', undefined, 'uhw180-incubation-1')).toBe(
      '- [UHW180 Incubation](#uhw180-incubation-1)'
    );
  });
});

describe('githubHeadingAnchor', () => {
  it('lowercases ASCII only, drops punctuation and maps each space to a hyphen', () => {
    expect(githubHeadingAnchor('[UHW180 Incubation] 계대 1일차')).toBe('uhw180-incubation-계대-1일차');
    expect(githubHeadingAnchor('팔레트에 없는 기능 (우클릭 · 클릭 전용)')).toBe(
      '팔레트에-없는-기능-우클릭--클릭-전용'
    );
    expect(githubHeadingAnchor('Greek Θ snake_case x-y')).toBe('greek-Θ-snake_case-x-y');
  });
});

// #505: Obsidian resolves `#` links by heading text, so the TOC's anchors need a hand.
describe('resolveGithubAnchor', () => {
  it('finds the heading line of every TOC anchor, numbered repeats included', () => {
    const md = buildNote([
      ['UHW010', 'Liquid Handling'],
      ['UHW010', 'Liquid Handling'],
    ]);
    const lines = md.split('\n');
    const anchors = [...md.matchAll(/^- \[.*\]\(#(.*)\)$/gm)].map(m => m[1]);
    expect(anchors).toHaveLength(2);
    const targets = anchors.map(a => resolveGithubAnchor(md, `#${a}`));
    expect(targets[0]).not.toBe(targets[1]);
    for (const line of targets) expect(lines[line!]).toBe('### [UHW010 Liquid Handling]');
  });

  it('reads a percent-encoded anchor and gives undefined for no heading', () => {
    const md = '---\ntitle: x\n---\n\n### [USW340 Computation] 농축 유전자 순위\n';
    expect(resolveGithubAnchor(md, '#usw340-computation-농축-유전자-순위')).toBe(4);
    expect(resolveGithubAnchor(md, `#${encodeURIComponent('usw340-computation-농축-유전자-순위')}`)).toBe(4);
    expect(resolveGithubAnchor(md, '#nothing')).toBeUndefined();
  });
});

describe('rebuildUnitOpToc emptying the toc', () => {
  // The line break the removed entries ended on stays, so the text above them
  // does not become a setext heading over the separator.
  it.each([
    ['LF', '## Related Unit Operations\ntext\n- [U1 A](#u1-a)\n---\n', '## Related Unit Operations\ntext\n\n---\n'],
    ['CRLF', '## Related Unit Operations\r\ntext\r\n- [U1 A](#u1-a)\r\n---\r\n', '## Related Unit Operations\r\ntext\r\n\r\n---\r\n'],
    ['mixed', '## Related Unit Operations\r\ntext\n- [U1 A](#u1-a)\r\n---\n', '## Related Unit Operations\r\ntext\n\r\n---\n'],
    ['two entries', '## Related Unit Operations\ntext\n- [U1 A](#u1-a)\n- [U2 B](#u2-b)\n---\n', '## Related Unit Operations\ntext\n\n---\n'],
  ])('keeps the break before the separator (%s)', (_name, md, want) => {
    expect(rebuildUnitOpToc(md)).toBe(want);
  });
});

describe('rebuildUnitOpToc anchors', () => {
  const note = (head: string[], body: string[]): string =>
    [...head, '## Related Unit Operations', '', ...body, '', '## Conclusions and Discussion', ''].join('\n');
  const tocAnchors = (md: string): string[] => [...md.matchAll(/^- \[.*\]\(#(.*)\)$/gm)].map(m => m[1]);

  it('numbers repeated unit ops -1, -2 across all headings', () => {
    const md = note([], [
      '---', '', '### [UHW180 Incubation]', '', '#### Meta', '',
      '---', '', '### [UHW180 Incubation] 계대 1일차', '', '#### Meta', '',
      '---', '', '### [UHW180 Incubation]', '', '#### Meta', '',
      '---', '', '### [UHW180 Incubation]',
    ]);
    expect(tocAnchors(rebuildUnitOpToc(md))).toEqual([
      'uhw180-incubation',
      'uhw180-incubation-계대-1일차',
      'uhw180-incubation-1',
      'uhw180-incubation-2',
    ]);
  });

  it('counts a non-unit-op heading with the same anchor', () => {
    const md = note(['# UHW010 A', ''], ['---', '', '### [UHW010 A]']);
    expect(tocAnchors(rebuildUnitOpToc(md))).toEqual(['uhw010-a-1']);
  });

  it('ignores front matter and fenced headings', () => {
    const md = note(['---', '# UHW010 A', '---', ''], [
      '```', '### [UHW010 A]', '```', '', '---', '', '### [UHW010 A]',
    ]);
    expect(tocAnchors(rebuildUnitOpToc(md))).toEqual(['uhw010-a']);
  });

  it('fixes a stale anchor in place without calling it a reorder', () => {
    const md = note([], ['- [UHW180 Incubation | 계대 1일차](#uhw180-incubation-1)', '', '---', '', '### [UHW180 Incubation] 계대 1일차']);
    expect(computeUnitOpSyncEdits(md, { onlyOnReorder: true })).toEqual([]);
    const out = rebuildUnitOpToc(md);
    expect(tocAnchors(out)).toEqual(['uhw180-incubation-계대-1일차']);
    expect(computeUnitOpSyncEdits(out)).toEqual([]);
  });
});

describe('findUnitOpInsertOffset', () => {
  const fresh = createWorkflowContent(
    { id: 'WD010', name: 'Design', description: 'desc' },
    'Dr. Kim'
  );

  it('points just before the heading that closes the section', () => {
    const offset = findUnitOpInsertOffset(fresh);
    expect(fresh.slice(offset)).toMatch(/^## Conclusions and Discussion/);
  });

  it('stays after existing blocks rather than stopping at their --- break', () => {
    const withBlock = fresh.replace(
      '## Conclusions and Discussion',
      ['---', '', '### [UHW010 Spin]', '', '> first', '', '## Conclusions and Discussion'].join('\n')
    );
    const offset = findUnitOpInsertOffset(withBlock);
    expect(offset).toBeGreaterThan(withBlock.indexOf('### [UHW010 Spin]'));
    expect(withBlock.slice(offset)).toMatch(/^## Conclusions and Discussion/);
  });

  it('falls back to the end of the document when the section is missing', () => {
    const md = '# Freeform note\n\nbody\n';
    expect(findUnitOpInsertOffset(md)).toBe(md.length);
  });

  it('falls back to the end when the section is the last one', () => {
    const md = '## Related Unit Operations\n\n> hint\n';
    expect(findUnitOpInsertOffset(md)).toBe(md.length);
  });

  it('handles CRLF documents', () => {
    const crlf = fresh.replace(/\n/g, '\r\n');
    const offset = findUnitOpInsertOffset(crlf);
    expect(crlf.slice(offset)).toMatch(/^## Conclusions and Discussion/);
  });
});

// The new entry goes after the last `- [` line, a hand-written link included; code examples aside.
// A list fence's closer (`  ~~~` under `- ~~~md`) closes it, as CommonMark and Obsidian read it,
// so the `~~~` below opens a fence left open to the end: the toc is code there, and nothing is
// written into it (read as an opener, the closer had paired with that `~~~` and the entry went
// into the ```md example).
describe('appendUnitOpToWorkflowToc after a list fence', () => {
  it('leaves the toc of a fence left open after a list fence alone', () => {
    const md = '\n### [UHW010 A]\n\n#### Method\n\n\n- ~~~md\n\n  ~~~\n\n---\n\n### [UHW010 A]\n\n#### Method\n\n\n~~~\n- [ ] [A](./001_WD010_A.labnote.md)\n### [UHW030 C]\n- [Protocol](https://example.org)\n\n---\n\n\n## Related Unit Operations\n- [UHW010 A](#uhw010-a)\n- [UHW010 A](#uhw010-a)\n- [UHW030 C](#uhw030-c)\n```md\n- [Protocol](https://example.org/p)\n```\n## Related Workflows\n';
    expect(appendUnitOpToWorkflowToc(md, 'UHW020', 'B')).toBe(md);
  });
});

describe('appendUnitOpToWorkflowToc after a hand-written link', () => {
  // A one-line ```inline``` is no fence (CommonMark), so the code block after it is read right.
  it('reads a one-line inline code span as no fence', () => {
    const t = '```';
    const md = ['## Related Unit Operations', '', `${t}inline${t}`, t, '- [UHW010 Example](#uhw010-example)', t, '- [Protocol](https://example.org/protocol)', ''].join('\n');
    expect(appendUnitOpToWorkflowToc(md, 'UHW020', 'B')).toBe(md.replace(/\n$/, '\n- [UHW020 B](#uhw020-b)\n'));
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('goes after the last list link (%s)', (_name, nl) => {
    const md = ['## Related Unit Operations', '', '- [UHW010 Spin](#uhw010-spin)', '- [Protocol](https://example.org/protocol)', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'USW020', 'Align')).toBe(
      ['## Related Unit Operations', '', '- [UHW010 Spin](#uhw010-spin)', '- [Protocol](https://example.org/protocol)', '- [USW020 Align](#usw020-align)', ''].join(nl)
    );
  });
});

describe('appendUnitOpToWorkflowToc', () => {
  const fresh = createWorkflowContent(
    { id: 'WD010', name: 'Design', description: 'desc' },
    'Dr. Kim'
  );

  it('inserts an entry into the fresh template section, preserving hints and other sections', () => {
    const out = appendUnitOpToWorkflowToc(fresh, 'UHW010', 'Centrifugation');
    expect(out).toContain('- [UHW010 Centrifugation](#uhw010-centrifugation)');
    // Hints preserved.
    expect(out).toContain('> Unit operations are appended here automatically.');
    // Other sections untouched.
    expect(out).toContain('## Conclusions and Discussion');
    // Entry sits inside the Related Unit Operations section (before Conclusions).
    expect(out.indexOf('#uhw010-centrifugation')).toBeLessThan(
      out.indexOf('## Conclusions and Discussion')
    );
  });

  it('accumulates multiple entries (grouped, in order)', () => {
    let out = appendUnitOpToWorkflowToc(fresh, 'UHW010', 'Spin');
    out = appendUnitOpToWorkflowToc(out, 'USW020', 'Align', 'BWA');
    const first = out.indexOf('- [UHW010 Spin]');
    const second = out.indexOf('- [USW020 Align | BWA]');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it('appends after existing serialize-style entries', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
    ].join('\n');
    const out = appendUnitOpToWorkflowToc(md, 'USW020', 'B');
    const lines = out.split('\n');
    // New entry directly after the last existing entry, before the blank+---.
    expect(lines[2]).toBe('- [UHW010 A](#uhw010-a)');
    expect(lines[3]).toBe('- [USW020 B](#usw020-b)');
    expect(lines[4]).toBe('');
    expect(lines[5]).toBe('---');
  });

  it('returns the document unchanged when the section is absent', () => {
    const md = '# Just a note\n\nNo TOC here.\n';
    expect(appendUnitOpToWorkflowToc(md, 'UHW010', 'X')).toBe(md);
  });

  // The last `- [` line in a closed unindented fence is no place for the entry.
  it.each([['```', '\n'], ['```', '\r\n'], ['~~~', '\n'], ['~~~', '\r\n']])('goes after the last entry out of code (%s, %j)', (f, nl) => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', f + 'md', '- [X](#x)', f, ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', '- [U3 C](#u3-c)', f + 'md', '- [X](#x)', f, ''].join(nl));
  });

  // An indented fence may be a list item's and end with it (CommonMark): the entry goes last, as before.
  it.each([['\n'], ['\r\n']])('goes after the last entry past a list item fence (%j)', nl => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', '  ~~~md', '  example', '- [Protocol](https://example.org/p)', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U9', 'New')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', '  ~~~md', '  example', '- [Protocol](https://example.org/p)', '- [U9 New](#u9-new)', ''].join(nl));
  });

  // A line in an HTML block is no entry (CommonMark: the block is HTML, a fence in it no code):
  // the entry goes after the last one out of it.
  it.each([['<!--', '-->', '\n'], ['<!--', '-->', '\r\n'], ['<div>', '</div>', '\n']])('goes after the last entry out of an HTML block (%s, %j)', (open, close, nl) => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', '', open, '```', '- [U2 B](#u2-b)', '```', close, ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', '- [U3 C](#u3-c)', '', open, '```', '- [U2 B](#u2-b)', '```', close, ''].join(nl));
  });

  // A run closed with a space CommonMark does not count (NBSP and the like) is no closer
  // there: the entry goes after the last entry line, as before.
  const oddSpaces = ['\u00a0', '\u2000', '\u2003', '\u202f', '\u205f', '\u3000', '\ufeff', '\u1680'];
  it.each(oddSpaces.flatMap(sp => ['~~~', '```'].flatMap(f => [['\n', f, sp], ['\r\n', f, sp]])))(
    'goes after the last entry when a run is closed with another space (%j, %s, %j)',
    (nl, f, sp) => {
      const md = ['## Related Unit Operations', f, f + sp, '- [U1 A](#u1-a)', f, '- [U2 B](#u2-b)', f, ''].join(nl);
      expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', f, f + sp, '- [U1 A](#u1-a)', f, '- [U2 B](#u2-b)', '- [U3 C](#u3-c)', f, ''].join(nl));
    }
  );

  // A lone CR ends a line for CommonMark, not for this reading: the entry goes last, as before.
  it.each(['~~~', '```'].flatMap(f => [[f, '\n'], [f, '\r\n']]))('goes after the last entry when a fence line holds a lone CR (%s, %j)', (f, nl) => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', f + '\r' + f, '- [U2 B](#u2-b)', f, ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', f + '\r' + f, '- [U2 B](#u2-b)', '- [U3 C](#u3-c)', f, ''].join(nl));
  });

  // Other separators are no line end to CommonMark either: after a closing run they make it
  // no closer (as before), and inside a ~~~ opener's info the fence holds the entry line below.
  const seps = ['\u2028', '\u2029', '\u0085', '\f', '\v'];
  it.each(seps.flatMap(c => ['~~~', '```'].flatMap(f => [[f, c, '\n'], [f, c, '\r\n']])))('goes after the last entry when a closing run has %s then %j (%j)', (f, c, nl) => {
    const md = ['## Related Unit Operations', f, f + c, '- [U1 A](#u1-a)', f, '- [U2 B](#u2-b)', f, ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', f, f + c, '- [U1 A](#u1-a)', f, '- [U2 B](#u2-b)', '- [U3 C](#u3-c)', f, ''].join(nl));
  });
  it.each(seps.flatMap(c => [[c, '\n'], [c, '\r\n']]))('keeps the entry out of a ~~~ fence whose info holds %j (%j)', (c, nl) => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', '~~~' + c + '~~~', '- [U2 B](#u2-b)', '~~~', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', '- [U3 C](#u3-c)', '~~~' + c + '~~~', '- [U2 B](#u2-b)', '~~~', ''].join(nl));
  });

  it.each([['\n'], ['\r\n']])('adds nothing when the only entry line is in a code example (%j)', nl => {
    const md = ['## Related Unit Operations', '', '```md', '- [UHW001 Example](#x)', '```', '', 'Text', '', '## Conclusions', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'UHW010', 'Spin')).toBe(md);
  });

  // The section ends where it did before, a `##` line in code included; only a place in code is passed over.
  it('ends the section at a `##` line as before, a code example included', () => {
    const md = '## Related Unit Operations\n\n```md\n## Not a heading\n```\n\n- [UHW010 A](#uhw010-a)\n\n## Conclusions\n';
    expect(appendUnitOpToWorkflowToc(md, 'USW020', 'B')).toBe(
      '## Related Unit Operations\n\n- [USW020 B](#usw020-b)\n\n```md\n## Not a heading\n```\n\n- [UHW010 A](#uhw010-a)\n\n## Conclusions\n'
    );
  });

  it.each([['```', '\n'], ['```', '\r\n'], ['~~~', '\n'], ['~~~', '\r\n']])('appends past a unit operation heading in a code example (%s, %j)', (f, nl) => {
    const md = ['## Related Unit Operations', '- [U1 A](#u1-a)', f + 'md', '### [U99 Example]', f, '- [U2 B](#u2-b)', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '- [U1 A](#u1-a)', f + 'md', '### [U99 Example]', f, '- [U2 B](#u2-b)', '- [U3 C](#u3-c)', ''].join(nl));
  });

  it.each([['\n'], ['\r\n']])('appends under a bracketed subheading that names no unit operation (%j)', nl => {
    const md = ['## Related Unit Operations', '### [Group]', '- [U1 A](#u1-a)', ''].join(nl);
    expect(appendUnitOpToWorkflowToc(md, 'U3', 'C')).toBe(['## Related Unit Operations', '### [Group]', '- [U1 A](#u1-a)', '- [U3 C](#u3-c)', ''].join(nl));
  });

  it.each([
    ['front matter fence', '---\ndescription: |\n  ```inline```\n  ```\n---\n## Related Unit Operations\n\n- [UHW010 A](#uhw010-a)\n\n---\n### [UHW010 A]\n', '---\ndescription: |\n  ```inline```\n  ```\n---\n## Related Unit Operations\n\n- [UHW010 A](#uhw010-a)\n- [UHW020 B](#uhw020-b)\n\n---\n### [UHW010 A]\n'],
    ['unit op body', '## Related Unit Operations\n- [UHW010 A](#uhw010-a)\n```md\n## Example heading\n```\n### [UHW010 A]\n- [Protocol](https://example.org)\n## Notes\ntail\n', '## Related Unit Operations\n- [UHW010 A](#uhw010-a)\n- [UHW020 B](#uhw020-b)\n```md\n## Example heading\n```\n### [UHW010 A]\n- [Protocol](https://example.org)\n## Notes\ntail\n'],
  ])('appends as before after a %s', (_name, md, want) => {
    expect(appendUnitOpToWorkflowToc(md, 'UHW020', 'B')).toBe(want);
  });

  it('preserves CRLF line endings', () => {
    const md = '## Related Unit Operations\r\n\r\n## Conclusions and Discussion\r\n';
    const out = appendUnitOpToWorkflowToc(md, 'UHW010', 'X');
    expect(out).toContain('\r\n');
    expect(out).toContain('- [UHW010 X](#uhw010-x)');
  });
});

describe('rebuildUnitOpToc', () => {
  it('leaves an up-to-date TOC with mixed line endings byte for byte', () => {
    const md = '## Related Unit Operations\n\n- [U1 A](#u1-a)\r\n- [U2 B](#u2-b)\n\n### [U1 A]\n### [U2 B]\n';
    expect(rebuildUnitOpToc(md)).toBe(md);
    expect(computeUnitOpSyncEdits(md)).toEqual([]);
  });

  it('moves reordered entries with their own line endings and gives a new one the ending above it', () => {
    const md = '## Related Unit Operations\r\n\n- [U2 B](#u2-b)\n- [U1 A](#u1-a)\r\n\n### [U1 A]\n### [U2 B]\n### [U3 C]\n';
    expect(rebuildUnitOpToc(md)).toBe(
      '## Related Unit Operations\r\n\n- [U1 A](#u1-a)\r\n- [U2 B](#u2-b)\n- [U3 C](#u3-c)\n\n### [U1 A]\n### [U2 B]\n### [U3 C]\n'
    );
  });

  it('reorders the TOC to match document heading order (A, C, B)', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [USW020 B](#usw020-b)',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '> d',
      '',
      '---',
      '',
      '### [UHW030 C]',
      '',
      '> d',
      '',
      '---',
      '',
      '### [USW020 B]',
      '',
      '> d',
      '',
      '## Conclusions and Discussion',
      '',
    ].join('\n');

    const out = rebuildUnitOpToc(md);
    const a = out.indexOf('- [UHW010 A](#uhw010-a)');
    const c = out.indexOf('- [UHW030 C](#uhw030-c)');
    const b = out.indexOf('- [USW020 B](#usw020-b)');
    expect(a).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(c);
    // The reordered entries stay inside the section (before Conclusions).
    expect(b).toBeLessThan(out.indexOf('## Conclusions and Discussion'));
  });

  it('reflects reversed document order (B, A)', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [USW020 B](#usw020-b)',
      '',
      '---',
      '### [USW020 B]',
      '---',
      '### [UHW010 A]',
    ].join('\n');

    const out = rebuildUnitOpToc(md);
    expect(out.indexOf('- [USW020 B]')).toBeLessThan(out.indexOf('- [UHW010 A]'));
  });

  it('includes the alias from an aliased heading', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [USW010 Read Mapping](#usw010-read-mapping)',
      '',
      '---',
      '### [USW010 Read Mapping] BWA',
    ].join('\n');

    const out = rebuildUnitOpToc(md);
    expect(out).toContain('- [USW010 Read Mapping | BWA](#usw010-read-mapping-bwa)');
  });

  it('leaves a fresh template unchanged (no headings, hints preserved)', () => {
    const fresh = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim');
    const out = rebuildUnitOpToc(fresh);
    expect(out).toBe(fresh);
    expect(out).toContain('> Unit operations are appended here automatically.');
  });

  it('returns the document unchanged when the section is absent', () => {
    const md = '# Just a note\n\nNo TOC here.\n';
    expect(rebuildUnitOpToc(md)).toBe(md);
  });

  it('preserves CRLF line endings', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '',
      '---',
      '### [UHW010 A]',
    ].join('\r\n');
    const out = rebuildUnitOpToc(md);
    expect(out).toContain('\r\n');
    expect(out).toContain('- [UHW010 A](#uhw010-a)');
  });

  it('keeps non-entry lines interleaved between TOC entries (no over-splice)', () => {
    // A comment/quote sitting between two entry lines must survive the rebuild.
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '> keep me between entries',
      '- [USW020 B](#usw020-b)',
      '',
      '---',
      '### [UHW010 A]',
      '---',
      '### [USW020 B]',
      '',
      '## Conclusions and Discussion',
      '',
    ].join('\n');

    const out = rebuildUnitOpToc(md);
    expect(out).toContain('> keep me between entries');
    // Both entries still present and in document order.
    expect(out.indexOf('- [UHW010 A]')).toBeGreaterThan(-1);
    expect(out.indexOf('- [USW020 B]')).toBeGreaterThan(out.indexOf('- [UHW010 A]'));
  });
});

describe('computeUnitOpSyncEdits', () => {
  const alpha: [string, string] = ['UHW010', 'Alpha'];
  const beta: [string, string] = ['UHW020', 'Beta'];
  const gamma: [string, string] = ['UHW030', 'Gamma'];
  const abc = buildNote([alpha, beta, gamma]);
  const A = '### [UHW010 Alpha]';
  const B = '### [UHW020 Beta]';
  const C = '### [UHW030 Gamma]';

  it('tidies an Outline drag (C before A) into the template shape', () => {
    const dragged = outlineMove(abc, C, A);
    // The drag itself leaves A without a break and one dangling before Conclusions.
    expect(prevNonBlank(dragged, dragged.indexOf(A))).not.toBe('---');
    expect(prevNonBlank(dragged, dragged.indexOf('## Conclusions and Discussion'))).toBe('---');

    const out = tidy(dragged);
    expect(tocOrder(out)).toEqual(['UHW030', 'UHW010', 'UHW020']);
    expectTemplateShape(out);
    // Same note as inserting in C, A, B order, up to blank-line runs.
    expect(collapseBlanks(out)).toBe(collapseBlanks(buildNote([gamma, alpha, beta])));
    for (const name of ['Alpha', 'Beta', 'Gamma']) expect(out).toContain(`> ${name} step`);
  });

  it('matches a note built in the moved order, for every drag direction', () => {
    const cases: [string, string | null, string[]][] = [
      [C, A, ['UHW030', 'UHW010', 'UHW020']],
      [A, null, ['UHW020', 'UHW030', 'UHW010']],
      [B, A, ['UHW020', 'UHW010', 'UHW030']],
      [A, C, ['UHW020', 'UHW010', 'UHW030']],
    ];
    for (const [moved, before, order] of cases) {
      const out = tidy(outlineMove(abc, moved, before));
      expect(tocOrder(out)).toEqual(order);
      expectTemplateShape(out);
      // Every block body survives intact.
      for (const h of [A, B, C]) {
        const body = abc.slice(abc.indexOf(h)).split('\n\n---')[0].replace(/\n+$/, '');
        expect(out).toContain(body.split('## Conclusions')[0].replace(/\n+$/, ''));
      }
    }
  });

  it('returns sorted, non-overlapping edits that keep the TOC edit inside the list', () => {
    const dragged = outlineMove(abc, C, A);
    const edits = computeUnitOpSyncEdits(dragged);
    expect(edits.length).toBeGreaterThan(1);
    for (let i = 1; i < edits.length; i++) expect(edits[i].from).toBeGreaterThanOrEqual(edits[i - 1].to);
    const firstBlock = dragged.indexOf('### [');
    expect(edits[0].to).toBeLessThan(firstBlock);
    expect(dragged.slice(edits[0].from, edits[0].to)).not.toMatch(/^#|^---$/m);
  });

  it('is idempotent: a tidied note yields no further edits', () => {
    const out = tidy(outlineMove(abc, C, A));
    expect(computeUnitOpSyncEdits(out)).toEqual([]);
    expect(computeUnitOpSyncEdits(out, { onlyOnReorder: true })).toEqual([]);
  });

  it('leaves separators alone when the order is unchanged', () => {
    expect(computeUnitOpSyncEdits(abc)).toEqual([]);
    // A stray trailing break is not touched without a reorder.
    const dangling = abc.replace('## Conclusions and Discussion', '---\n\n## Conclusions and Discussion');
    expect(computeUnitOpSyncEdits(dangling)).toEqual([]);
  });

  it('only reorders the TOC in notes that do not use separators', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '### [UHW020 B]',
      '',
      'b body',
      '',
      '### [UHW010 A]',
      '',
      'a body',
      '',
      '## Conclusions and Discussion',
      '',
    ].join('\n');
    const edits = computeUnitOpSyncEdits(md);
    expect(edits).toHaveLength(1);
    const out = applyTextEdits(md, edits);
    expect(out).not.toContain('---');
    expect(out.indexOf('- [UHW020 B]')).toBeLessThan(out.indexOf('- [UHW010 A]'));
  });

  it('keeps a user --- that is followed by other content', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '---',
      '',
      '### [UHW020 B]',
      '',
      'b body',
      '',
      '---',
      '',
      'user note after a break',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '## Conclusions and Discussion',
    ].join('\n');
    const out = tidy(md);
    expect(out).toContain('b body\n\n---\n\nuser note after a break');
    expect(out.match(/^---$/gm)).toHaveLength(3);
  });

  it('merges back-to-back breaks and drops a dangling one', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '---',
      '',
      '---',
      '',
      '### [UHW020 B]',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      'a body',
      '',
      '---',
      '',
      '## Conclusions and Discussion',
    ].join('\n');
    const out = tidy(md);
    expect(out.match(/^---$/gm)).toHaveLength(2);
    expect(out).toContain('a body\n\n## Conclusions and Discussion');
  });

  it('does not turn text into a setext heading when inserting a break', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '---',
      '',
      '### [UHW020 B]',
      'b body',
      '### [UHW010 A]',
      '',
      '## Conclusions and Discussion',
    ].join('\n');
    expect(tidy(md)).toContain('b body\n\n---\n\n### [UHW010 A]');
  });

  it('with onlyOnReorder, ignores added, removed and renamed headings', () => {
    const added = abc.replace('## Conclusions and Discussion', '---\n\n### [UHW040 Delta]\n\n## Conclusions and Discussion');
    expect(computeUnitOpSyncEdits(added, { onlyOnReorder: true })).toEqual([]);
    expect(computeUnitOpSyncEdits(added)).toHaveLength(1);
    const renamed = abc.replace(B, '### [UHW020 Betamax]');
    expect(computeUnitOpSyncEdits(renamed, { onlyOnReorder: true })).toEqual([]);
    expect(computeUnitOpSyncEdits(abc, { onlyOnReorder: true })).toEqual([]);
  });

  it('detects a reorder when the same unit op appears twice', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '- [UHW010 A](#uhw010-a)',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '---',
      '',
      '### [UHW020 B]',
      '',
      '## Conclusions and Discussion',
    ].join('\n');
    const out = applyTextEdits(md, computeUnitOpSyncEdits(md, { onlyOnReorder: true }));
    expect([...out.matchAll(/^- \[(\w+) /gm)].map(m => m[1])).toEqual(['UHW010', 'UHW010', 'UHW020']);
    // The pre-numbering TOC (both `#uhw010-a`) still reads as a reorder, and the second A gets `-1`.
    expect(out).toContain('- [UHW010 A](#uhw010-a)\n- [UHW010 A](#uhw010-a-1)\n- [UHW020 B](#uhw020-b)');
    expect(computeUnitOpSyncEdits(out)).toEqual([]);
    // One A dropped from the TOC is an edit, not a reorder.
    const fewer = md.replace('- [UHW010 A](#uhw010-a)\n- [UHW020 B]', '- [UHW020 B]');
    expect(computeUnitOpSyncEdits(fewer, { onlyOnReorder: true })).toEqual([]);
  });

  it('bounds the TOC at the first heading when the leading --- is gone', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '### [UHW020 B]',
      '',
      '- [ ] todo item',
      '- [protocol](protocol.md)',
      '',
      '### [UHW010 A]',
      '',
    ].join('\n');
    const out = rebuildUnitOpToc(md);
    expect(out).toContain('- [ ] todo item\n- [protocol](protocol.md)');
    expect(out.indexOf('- [UHW020 B]')).toBeLessThan(out.indexOf('- [UHW010 A]'));
  });

  it('ignores headings and breaks inside code fences', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW020 B](#uhw020-b)',
      '',
      '---',
      '',
      '### [UHW020 B]',
      '',
      '```md',
      '### [UHW099 Example]',
      '',
      '---',
      '```',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '~~~',
      '---',
      '~~~',
      '',
      '## Conclusions and Discussion',
    ].join('\n');
    const out = tidy(md);
    expect(out).not.toContain('- [UHW099');
    expect(out).toContain('```md\n### [UHW099 Example]\n\n---\n```');
    expect(out).toContain('~~~\n---\n~~~');
    expect(out.indexOf('- [UHW020 B]')).toBeLessThan(out.indexOf('- [UHW010 A]'));
  });

  it('preserves CRLF line endings', () => {
    const crlf = outlineMove(abc, C, A).replace(/\n/g, '\r\n');
    const out = tidy(crlf);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toBe(tidy(outlineMove(abc, C, A)).replace(/\n/g, '\r\n'));
  });

  it('applies the same TOC result as rebuildUnitOpToc', () => {
    const inputs = [
      abc,
      outlineMove(abc, C, A),
      abc.replace(B, '### [UHW020 Betamax]'),
      buildNote([]),
      buildNote([beta, alpha]).replace('- [UHW020 Beta](#uhw020-beta)\n', ''),
      '## Related Unit Operations\n\n- [UHW010 A](#uhw010-a)\n> keep\n- [UHW020 B](#uhw020-b)\n\n---\n### [UHW020 B]\n---\n### [UHW010 A]\n',
      '## Related Unit Operations\n\n> hint\n\n### [UHW010 A]\n',
    ];
    for (const md of inputs) {
      const firstBlock = md.includes('### [') ? md.indexOf('### [') : md.length + 1;
      const tocOnly = computeUnitOpSyncEdits(md).filter((e: TextEdit) => e.to < firstBlock);
      expect(applyTextEdits(md, tocOnly)).toBe(rebuildUnitOpToc(md));
    }
  });
});

describe('locateInsertedUnitOpHeading', () => {
  it('maps the inserted heading offset into the rebuilt text', () => {
    const head = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '> first',
      '',
    ].join('\n');
    const inserted = ['', '---', '', '### [USW020 B]', '', '> second', ''].join('\n');
    const tail = ['', '## Conclusions and Discussion', ''].join('\n');
    const mdAfterInsert = head + inserted + tail;
    const cursorBefore = head.length;

    const rebuilt = rebuildUnitOpToc(mdAfterInsert);
    const off = locateInsertedUnitOpHeading(mdAfterInsert, cursorBefore, rebuilt);

    expect(off).toBeGreaterThan(-1);
    expect(rebuilt.slice(off)).toMatch(/^### \[USW020 B\]/);
    // TOC grew by one entry, yet the mapped offset still lands on the heading.
    expect(rebuilt).toContain('- [USW020 B](#usw020-b)');
  });

  it('picks the inserted duplicate (by cursor), not the pre-existing one', () => {
    const head = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '',
      '---',
      '',
      '### [UHW010 A]',
      '',
      '> first',
      '',
    ].join('\n');
    const inserted = ['', '---', '', '### [UHW010 A]', '', '> second', ''].join('\n');
    const mdAfterInsert = head + inserted + '\n## Conclusions and Discussion\n';
    const cursorBefore = head.length;

    const rebuilt = rebuildUnitOpToc(mdAfterInsert);
    const off = locateInsertedUnitOpHeading(mdAfterInsert, cursorBefore, rebuilt);
    const firstOcc = rebuilt.indexOf('### [UHW010 A]');

    expect(off).toBeGreaterThan(firstOcc);
    expect(rebuilt.slice(off)).toMatch(/^### \[UHW010 A\][\s\S]*second/);
  });

  it('returns -1 when no heading exists at/after the cursor', () => {
    const md = '## Related Unit Operations\n\n> hint\n\n## Conclusions and Discussion\n';
    expect(locateInsertedUnitOpHeading(md, 0, md)).toBe(-1);
  });
});

// #562: Enter at the end of an entry left the caret in the next one once the sync moved the new line.
describe('shouldDeferTocSync', () => {
  it('waits while the caret is on the line the sync would move', () => {
    const before = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- ',
      '- [USW020 B](#usw020-b)',
      '',
      '### [UHW010 A]',
      '',
      '### [USW020 B]',
      '',
    ].join('\n');
    const edit = minimalReplacement(before, rebuildUnitOpToc(before))!;
    expect(edit).not.toBeNull();
    const caret = before.indexOf('- \n') + 2;
    expect(shouldDeferTocSync(caret, edit)).toBe(true);
    expect(shouldDeferTocSync(before.indexOf('### [USW020'), edit)).toBe(false);
  });

  it('counts both ends of the span as inside', () => {
    expect(shouldDeferTocSync(4, { start: 4, end: 4 })).toBe(true);
    expect(shouldDeferTocSync(9, { start: 4, end: 9 })).toBe(true);
    expect(shouldDeferTocSync(3, { start: 4, end: 9 })).toBe(false);
    expect(shouldDeferTocSync(10, { start: 4, end: 9 })).toBe(false);
  });
});

describe('minimalReplacement', () => {
  it('returns null when the strings are identical', () => {
    expect(minimalReplacement('same', 'same')).toBeNull();
  });

  it('isolates a changed middle span (shared prefix + suffix)', () => {
    const edit = minimalReplacement('abXYZcd', 'abWcd');
    expect(edit).toEqual({ start: 2, end: 5, text: 'W' });
  });

  it('describes a pure insertion at the end', () => {
    const edit = minimalReplacement('aaa', 'aaaa');
    // Applying it to the original reproduces `after`.
    const { start, end, text } = edit!;
    expect('aaa'.slice(0, start) + text + 'aaa'.slice(end)).toBe('aaaa');
  });

  it('describes a pure deletion', () => {
    const edit = minimalReplacement('hello world', 'hello');
    const { start, end, text } = edit!;
    expect('hello world'.slice(0, start) + text + 'hello world'.slice(end)).toBe('hello');
  });

  it('applied to a real TOC reorder reproduces rebuildUnitOpToc output', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [UHW010 A](#uhw010-a)',
      '- [USW020 B](#usw020-b)',
      '',
      '## Steps',
      '',
      '### [USW020 B]',
      '',
      '### [UHW010 A]',
      '',
    ].join('\n');
    const after = rebuildUnitOpToc(md);
    const edit = minimalReplacement(md, after);
    expect(edit).not.toBeNull();
    const { start, end, text } = edit!;
    expect(md.slice(0, start) + text + md.slice(end)).toBe(after);
  });
});

// #258: with automatic sorting off, names and links must still follow the headings.
// #457: an insert with sorting off adds one entry and leaves the rest in place.
describe('addUnitOpTocEntry', () => {
  const note = (toc: string[], headings: string[]): string =>
    ['## Related Unit Operations', '', ...toc, '', '---', '', ...headings.flatMap(h => [h, '']), ''].join('\n');
  const tocOf = (md: string) => md.split('\n').filter(l => l.startsWith('- ['));
  const at = (md: string, heading: string) => md.indexOf(heading);

  it('adds the entry after the block before it, keeping a hand-made order', () => {
    const md = note(['- [UHW020 B](#uhw020-b)', '- [UHW010 A](#uhw010-a)'], ['### [UHW010 A]', '### [UHW030 C]', '### [UHW020 B]']);
    expect(tocOf(addUnitOpTocEntry(md, at(md, '### [UHW030 C]')))).toEqual([
      '- [UHW020 B](#uhw020-b)',
      '- [UHW010 A](#uhw010-a)',
      '- [UHW030 C](#uhw030-c)',
    ]);
  });

  it('puts a first block before the entry of the block after it', () => {
    const md = note(['- [UHW020 B](#uhw020-b)', '- [UHW010 A](#uhw010-a)'], ['### [UHW030 C]', '### [UHW010 A]', '### [UHW020 B]']);
    expect(tocOf(addUnitOpTocEntry(md, at(md, '### [UHW030 C]')))).toEqual([
      '- [UHW020 B](#uhw020-b)',
      '- [UHW030 C](#uhw030-c)',
      '- [UHW010 A](#uhw010-a)',
    ]);
  });

  it('keeps blocks of one unit operation in note order among themselves', () => {
    const md = note(
      ['- [UHW010 A | late](#uhw010-a-late)', '- [UHW020 B](#uhw020-b)'],
      ['### [UHW020 B]', '### [UHW010 A] early', '### [UHW010 A] late']
    );
    expect(tocOf(refreshUnitOpTocEntries(addUnitOpTocEntry(md, at(md, '### [UHW010 A] early'))))).toEqual([
      '- [UHW010 A | early](#uhw010-a-early)',
      '- [UHW010 A | late](#uhw010-a-late)',
      '- [UHW020 B](#uhw020-b)',
    ]);
  });

  it('starts the list when there is none', () => {
    const md = note([], ['### [UHW010 A]']);
    expect(tocOf(addUnitOpTocEntry(md, at(md, '### [UHW010 A]')))).toEqual(['- [UHW010 A](#uhw010-a)']);
  });
});

describe('refreshUnitOpTocEntries', () => {
  const note = (toc: string[], headings: string[]): string =>
    ['## Related Unit Operations', '', ...toc, '', '---', '', ...headings, ''].join('\n');

  it('rewrites an entry whose unit operation was renamed, keeping the order', () => {
    const md = note(
      ['- [USW020 B](#usw020-b)', '- [UHW010 A](#uhw010-a)'],
      ['### [USW020 B]', '', '### [UHW010 Aseptic transfer]', '']
    );
    expect(refreshUnitOpTocEntries(md)).toBe(
      note(
        ['- [USW020 B](#usw020-b)', '- [UHW010 Aseptic transfer](#uhw010-aseptic-transfer)'],
        ['### [USW020 B]', '', '### [UHW010 Aseptic transfer]', '']
      )
    );
  });

  it('leaves the order alone where rebuildUnitOpToc would sort it', () => {
    const md = note(['- [USW020 B](#usw020-b)', '- [UHW010 A](#uhw010-a)'], ['### [UHW010 A]', '', '### [USW020 B]', '']);
    expect(refreshUnitOpTocEntries(md)).toBe(md);
    expect(rebuildUnitOpToc(md)).not.toBe(md);
  });

  it('takes the alias along and pairs repeats of one opId in order', () => {
    const md = note(
      ['- [UHW010 A](#uhw010-a)', '- [UHW010 A](#uhw010-a-1)'],
      ['### [UHW010 A] 1차', '', '### [UHW010 A] 2차', '']
    );
    expect(refreshUnitOpTocEntries(md)).toContain('- [UHW010 A | 1차](#uhw010-a-1차)');
    expect(refreshUnitOpTocEntries(md)).toContain('- [UHW010 A | 2차](#uhw010-a-2차)');
  });

  // #502: two blocks of one opId, listed in the order the user chose, went back to note order.
  it('keeps the order of two entries of one opId that match their headings', () => {
    const md = note(
      ['- [UHW010 A | 2차](#uhw010-a-2차)', '- [UHW010 A | 1차](#uhw010-a-1차)'],
      ['### [UHW010 A] 1차', '', '### [UHW010 A] 2차', '']
    );
    expect(refreshUnitOpTocEntries(md)).toBe(md);
  });

  it('leaves an entry no heading matches as it is', () => {
    const md = note(['- [UHW010 A](#uhw010-a)', '- [UHW999 Gone](#uhw999-gone)'], ['### [UHW010 A]', '']);
    expect(refreshUnitOpTocEntries(md)).toContain('- [UHW999 Gone](#uhw999-gone)');
  });

  // #372: a marker or memo after the link survives the refresh.
  it('keeps what follows the link of a renamed entry', () => {
    const md = note(['- [UHW010 A](#uhw010-a) @issue;ISS-a;조건 확인'], ['### [UHW010 Aseptic]', '']);
    expect(refreshUnitOpTocEntries(md)).toContain('- [UHW010 Aseptic](#uhw010-aseptic) @issue;ISS-a;조건 확인');
  });
});

// #372: the TOC is rebuilt from the headings, but what the user wrote after
// an entry's link is theirs.
describe('TOC entry tails', () => {
  const note = (toc: string[], headings: string[]): string =>
    ['## Related Unit Operations', '', ...toc, '', '---', '', ...headings, ''].join('\n');

  it('keeps a marker and a memo through a sort', () => {
    const md = note(
      ['- [USW020 B](#usw020-b) — 담당 테크니션 확인 필요', '- [UHW010 A](#uhw010-a) @issue;ISS-a;열 순환 조건'],
      ['### [UHW010 A]', '', '### [USW020 B]', '']
    );
    expect(rebuildUnitOpToc(md)).toBe(
      note(
        ['- [UHW010 A](#uhw010-a) @issue;ISS-a;열 순환 조건', '- [USW020 B](#usw020-b) — 담당 테크니션 확인 필요'],
        ['### [UHW010 A]', '', '### [USW020 B]', '']
      )
    );
  });

  it('leaves an entry with a tail alone when nothing else changed', () => {
    const md = note(['- [UHW010 A](#uhw010-a) @issue;ISS-a;x'], ['### [UHW010 A]', '']);
    expect(rebuildUnitOpToc(md)).toBe(md);
    expect(computeUnitOpSyncEdits(md)).toEqual([]);
  });

  // #520: a sync took a hand-written link line in the TOC for an entry and dropped it.
  it('keeps a hand-written link line in the TOC', () => {
    const memo = '- [프로토콜 원문](https://example.org/protocol)';
    const ordered = note(['- [UHW010 A](#uhw010-a)', '- [USW020 B](#usw020-b)', memo], ['### [UHW010 A]', '', '### [USW020 B]', '']);
    expect(rebuildUnitOpToc(ordered)).toBe(ordered);
    expect(computeUnitOpSyncEdits(ordered)).toEqual([]);
    const sorted = rebuildUnitOpToc(
      note(['- [USW020 B](#usw020-b)', memo, '- [UHW010 A](#uhw010-a)'], ['### [UHW010 A]', '', '### [USW020 B]', ''])
    );
    expect(sorted).toBe(ordered);
  });

  it('still reads a reorder when entries have tails', () => {
    const md = note(
      ['- [USW020 B](#usw020-b) 메모', '- [UHW010 A](#uhw010-a)'],
      ['### [UHW010 A]', '', '### [USW020 B]', '']
    );
    expect(computeUnitOpSyncEdits(md, { onlyOnReorder: true })).not.toEqual([]);
  });
});

// #367: a lone bracket in an alias must not break the TOC link.
describe('TOC labels with brackets', () => {
  it('escapes brackets in the label, not in the anchor', () => {
    expect(buildUnitOpTocLine('USW260', 'Hyperparameter Tuning', 'dropout 0.3] 2회차')).toBe(
      '- [USW260 Hyperparameter Tuning | dropout 0.3\\] 2회차](#usw260-hyperparameter-tuning-dropout-03-2회차)'
    );
    expect(buildUnitOpTocLine('USW240', 'Training', 'lr]1e-4 [재')).toBe(
      '- [USW240 Training | lr\\]1e-4 \\[재](#usw240-training-lr1e-4-재)'
    );
  });

  it('rewrites an old unescaped entry and keeps its tail', () => {
    const md = [
      '## Related Unit Operations',
      '',
      '- [USW260 T | a] b](#usw260-t-a-b) 메모',
      '',
      '---',
      '',
      '### [USW260 T] a] b',
      '',
    ].join('\n');
    expect(rebuildUnitOpToc(md)).toContain('- [USW260 T | a\\] b](#usw260-t-a-b) 메모');
  });
});
