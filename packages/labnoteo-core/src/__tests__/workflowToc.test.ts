import {
  buildUnitOpTocLine,
  githubHeadingAnchor,
  appendUnitOpToWorkflowToc,
  rebuildUnitOpToc,
  locateInsertedUnitOpHeading,
  findUnitOpInsertOffset,
  minimalReplacement,
  computeUnitOpSyncEdits,
  applyTextEdits,
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

  it('preserves CRLF line endings', () => {
    const md = '## Related Unit Operations\r\n\r\n## Conclusions and Discussion\r\n';
    const out = appendUnitOpToWorkflowToc(md, 'UHW010', 'X');
    expect(out).toContain('\r\n');
    expect(out).toContain('- [UHW010 X](#uhw010-x)');
  });
});

describe('rebuildUnitOpToc', () => {
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
