// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { joinSplitKeepingCr, splitKeepingCr } from '../util/lineEnds';
import {
  dedupeWorkflowChecklistEntries,
  insertWorkflowChecklistEntries,
  normalizeWorkflowChecklistLabels,
  parseWorkflowChecklistFromReadme,
  normalizeWorkflowChecklistLinks,
  reconcileWorkflowChecklist,
  relabelWorkflowChecklistEntries,
  relinkCopiedExperimentChecklist,
  relinkWorkflowChecklistEntries,
  removeWorkflowChecklistEntries,
} from '../lib/workflowStructure';
import { reassignIssueMarkerIds, stripIssueMarkers } from '../lib/issueMarker';
import { touchLastUpdatedDate, updateAllDateFields } from '../lib/dateUtils';

// A line moved or added to the end of a README without a final newline keeps
// no line-break CR there, whichever line ending its neighbours use (#442 follow-up).
describe('the last line of a README with mixed line endings', () => {
  const a = '- [ ] [A](./001_WD010_A.labnote.md)';
  const b = '- [ ] [B](./002_WD010_B.labnote.md)';

  it('reads an entry renumbered to the end', () => {
    const md = `## Related Workflows\n${a}\r\n${b}`;
    const out = reconcileWorkflowChecklist(md, [{ from: '001_WD010_A.labnote.md', to: '008_WD010_A.labnote.md' }], { move: true }).content;
    expect(out).toBe(`## Related Workflows\n${b}\r\n- [ ] [A](./008_WD010_A.labnote.md)`);
    expect(parseWorkflowChecklistFromReadme(out).map(e => e.fileName)).toEqual(['002_WD010_B.labnote.md', '008_WD010_A.labnote.md']);
  });

  it('reads an entry added after an LF line that follows a CRLF heading', () => {
    const md = `## Related Workflows\r\n\n${a}`;
    const out = insertWorkflowChecklistEntries(md, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }]);
    expect(out).toBe(`## Related Workflows\r\n\n${a}\n- [ ] [D](./004_WD010_D.labnote.md)`);
    expect(parseWorkflowChecklistFromReadme(out)).toHaveLength(2);
  });
});

describe('splitKeepingCr and joinSplitKeepingCr', () => {
  it('takes off only the \\r the split added', () => {
    for (const text of ['a\r\nb', 'a\r\nb\r', 'a\r\nb\r\n', 'a\nb', 'a\r']) {
      expect(joinSplitKeepingCr(text, splitKeepingCr(text))).toBe(text);
    }
  });

  it('leaves a README that ends in a bare CR unchanged when nothing is renamed', () => {
    const md = '## Related Workflows\r\n- [ ] [A](./001_WD010_A.labnote.md)\r';
    expect(reconcileWorkflowChecklist(md, [{ from: '009_WD010_X.labnote.md', to: '010_WD010_X.labnote.md' }], { move: true })).toEqual({ changed: false, content: md });
  });
});

// A CRLF note without a final newline: a writer that edits, moves, drops or
// adds its last line leaves no bare LF and no trailing CR (#442 follow-up).
describe('writers on a CRLF note without a final newline', () => {
  const crlf = (lf: string): string => lf.replace(/\n/g, '\r\n');
  const a = '- [ ] [A](./002_WD010_A.labnote.md)';
  const b = '- [ ] [B](./003_WD010_B.labnote.md)';
  const readme = ['## Related Workflows', a, b].join('\n');
  const dupe = ['## Related Workflows', b, a, '- [x] [B](./003_WD010_B.labnote.md)'].join('\n');
  const fm = '---\ntitle: T\nlast_updated_date: 2026-01-01\n---';
  const cases: [string, string, (md: string) => string][] = [
    ['insertWorkflowChecklistEntries', readme, md => insertWorkflowChecklistEntries(md, [{ done: false, title: 'C', fileName: '004_WD010_C.labnote.md' }])],
    ['reconcileWorkflowChecklist (move)', readme, md => reconcileWorkflowChecklist(md, [{ from: '003_WD010_B.labnote.md', to: '001_WD010_B.labnote.md' }], { move: true }).content],
    ['removeWorkflowChecklistEntries', readme, md => removeWorkflowChecklistEntries(md, ['003_WD010_B.labnote.md'])],
    ['dedupeWorkflowChecklistEntries', dupe, md => dedupeWorkflowChecklistEntries(md, ['003_WD010_B.labnote.md'])],
    ['relinkWorkflowChecklistEntries', readme, md => relinkWorkflowChecklistEntries(md, [{ from: '003_WD010_B.labnote.md', to: '005_WD010_B.labnote.md' }])],
    ['relabelWorkflowChecklistEntries', readme, md => relabelWorkflowChecklistEntries(md, [{ fileName: '003_WD010_B.labnote.md', from: 'B', to: 'Bee' }])],
    ['normalizeWorkflowChecklistLabels', readme.replace('[B]', '[B\\]'), md => normalizeWorkflowChecklistLabels(md)],
    ['normalizeWorkflowChecklistLinks', readme.replace('(./003', '(exp/003'), md => normalizeWorkflowChecklistLinks(md, 'exp').content],
    ['relinkCopiedExperimentChecklist', readme.replace('(./003', '(labnote/002_X/003'), md => relinkCopiedExperimentChecklist(md, 'labnote/005_Y', ['003_WD010_B.labnote.md']).content],
    ['reassignIssueMarkerIds', 'x\n@issue;ISS-a;topic', md => reassignIssueMarkerIds(md, () => 'ISS-b').content],
    ['stripIssueMarkers', 'x\n@issue;ISS-a;topic', stripIssueMarkers],
    ['updateAllDateFields', fm, md => updateAllDateFields(md, 'last_updated_date', '2026-10-29')],
    ['touchLastUpdatedDate', fm, md => touchLastUpdatedDate(md, '2026-10-29')],
  ];

  it.each(cases)('%s', (_name, lf, write) => {
    const md = crlf(lf);
    const out = write(md);
    expect(out).not.toBe(md);
    expect(out).not.toMatch(/(^|[^\r])\n/);
    expect(out).not.toMatch(/\r(?!\n)/);
    expect(out.endsWith('\n')).toBe(false);
  });
});
