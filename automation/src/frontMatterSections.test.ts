// Globals convention (no `import ... from 'vitest'`), matches the automation tests.
//
// The wiki section a model reads is the one `replaceSectionBody` writes, and a heading counts as
// there only as it finds it: a `## …` YAML comment in the front matter is no section.
import { parseFrontMatterYaml, parseIssueMarkers, replaceSectionBody } from '@labnoteo/core';
import { buildDiscussionIssue, extractObjective, getSectionBody } from './lib/experiments';
import { findingTitlesIn, withSectionHeading } from './wiki-propose';

describe('a wiki file whose front matter has a ## comment', () => {
  const md = '---\n## Methods\nexample: fake\n---\n# Wiki\n## Methods\nREAL\n';

  it('reads the section it replaces', () => {
    expect(getSectionBody(md, 'Methods')).toBe('REAL');
    const out = replaceSectionBody(md, 'Methods', 'NEW');
    expect(out.ok).toBe(true);
    expect(out.md).toBe('---\n## Methods\nexample: fake\n---\n# Wiki\n## Methods\n\nNEW\n');
  });

  it('gets the heading added when only the comment names it, and is then replaced', () => {
    const only = '---\n## Methods\ntag: x\n---\n# Wiki';
    const added = withSectionHeading(only, 'wiki-staging/Methods.md', 'Methods');
    expect(added).toBe('---\n## Methods\ntag: x\n---\n# Wiki\n\n## Methods\n');
    expect(replaceSectionBody(added, 'Methods', 'NEW').ok).toBe(true);
  });

  it('has its finding titles from the body only', () => {
    expect(findingTitlesIn('---\n### Fake finding\ntag: x\n---\n# Results\n### Real finding\n')).toEqual(['Real finding']);
  });
});

// A README body comes with its front matter taken off: a `---` pair at its top is two breaks.
describe('a README body whose first section sits between `---` breaks', () => {
  const raw = '---\ntitle: PCR\n---\n\n---\n## 🎯 Experiment Objective\nMeasure yield. @issue;q1;Is it enough?\n\n---\n## Methods\nRun PCR.\n';
  const { frontMatter, body } = parseFrontMatterYaml(raw);
  const note = { dir: 'labnote/001_PCR', folderName: '001_PCR', frontMatter, body };

  it('has its objective read', () => {
    expect(extractObjective(body)).toBe('Measure yield. @issue;q1;Is it enough?');
  });

  it('gives a marker there its section', () => {
    const [marker] = parseIssueMarkers(body).markers;
    const issue = buildDiscussionIssue(note, { path: 'labnote/001_PCR/README.labnote.md', body, bodyLineOffset: 4 }, marker, 'o/r');
    expect(issue.body).toContain('→ 🎯 Experiment Objective');
  });
});
