// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { removeWorkflowFromReadme } from '../lib/workflowDelete';

describe('workflow deletion section boundaries', () => {
  const entry = '- [ ] [Design](./001_WD010_Design.labnote.md)';
  const file = '001_WD010_Design.labnote.md';

  it.each(['\n', '\r\n'])('preserves other sections and fenced examples with %j', newline => {
    const before = ['# Experiment', entry, '```md', '## Related Workflows', entry, '```', ''];
    const section = ['## 🗂️ Related Workflows', '> Instructions  ', '~~~~md', '## Notes', entry, '```', entry, '~~~~', '### Nested'];
    const after = ['## Notes', entry, '# Appendix', entry, ''];
    const md = [...before, ...section, entry, ...after].join(newline);
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true,
      content: [...before, ...section, ...after].join(newline),
    });
  });

  it.each(['## Notes', '# Notes'])('stops at the next same or higher heading %s', boundary => {
    const md = ['## Related Workflows', entry, boundary, entry].join('\n');
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true, content: ['## Related Workflows', boundary, entry].join('\n'),
    });
  });

  it.each([
    ['## Related Workflows', '## Notes', entry],
    ['```md', '## Related Workflows', entry, '```'],
    ['## Related Workflows', '~~~', entry],
  ])('preserves content without a real matching checklist: %j', (...lines) => {
    const md = lines.join('\r\n');
    expect(removeWorkflowFromReadme(md, file)).toEqual({ changed: false, content: md });
  });

  it('preserves mixed line endings and the final newline byte for byte', () => {
    const md = `## Related Workflows\r\n${entry}\n> keep  \r\n## Notes\n${entry}\r\n`;
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true, content: `## Related Workflows\r\n> keep  \r\n## Notes\n${entry}\r\n`,
    });
  });
});

// #298: delete under the same section the add path writes to.
describe('workflow deletion under translated or renamed sections', () => {
  const entry = '- [ ] [Design](./001_WD010_Design.labnote.md)';
  const sibling = '- [x] [Assay](./002_WS010_Assay.labnote.md)';
  const file = '001_WD010_Design.labnote.md';
  const headings = [
    '## 🗂️ Related Workflows',
    '## Related Workflows',
    '## 관련 워크플로',
    '## 🗂️ 관련 워크플로',
    '## Related Workflows (3/5)',
    '## Workflows',
  ];
  const cases = headings.flatMap(heading => ['\n', '\r\n'].map(newline => [heading, newline] as const));

  it.each(cases)('removes only the entry under %s with %j', (heading, newline) => {
    const head = ['# Experiment', '', heading, '> Instructions  '];
    const tail = [sibling, '', '## Notes', 'body', ''];
    const md = [...head, entry, ...tail].join(newline);
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true,
      content: [...head, ...tail].join(newline),
    });
  });

  it.each(['\n', '\r\n'])('keeps the link in other sections and fences under a renamed heading with %j', newline => {
    const before = ['# Experiment', entry, '## Workflows', sibling, '```md', entry, '```'];
    const after = ['## Notes', entry, ''];
    const md = [...before, entry, ...after].join(newline);
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true,
      content: [...before, ...after].join(newline),
    });
  });
});

const README = [
  '# Experiment',
  '',
  '## Related Workflows',
  '',
  '> Instructions stay put.',
  '',
  '- [ ] [Design](./001_WD010_Design.labnote.md)',
  '- [x] [Assay](./002_WS010_Assay.labnote.md)',
  '',
  '## Notes',
  '',
  'body',
].join('\n');

describe('removeWorkflowFromReadme', () => {
  it('removes only the matching checklist entry, preserving order and siblings', () => {
    const res = removeWorkflowFromReadme(README, '001_WD010_Design.labnote.md');
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain('001_WD010_Design.labnote.md');
    // The sibling entry, instruction blockquote and other sections are intact.
    expect(res.content).toContain('- [x] [Assay](./002_WS010_Assay.labnote.md)');
    expect(res.content).toContain('> Instructions stay put.');
    expect(res.content).toContain('## Notes');
  });

  it('returns changed:false when the file is not listed', () => {
    const res = removeWorkflowFromReadme(README, '999_WD999_Missing.labnote.md');
    expect(res.changed).toBe(false);
    expect(res.content).toBe(README);
  });

  it('matches a non-ASCII filename that the strict checklist parser would reject', () => {
    const md = ['## Related Workflows', '', '- [ ] [실험](./003_WD010_실험.labnote.md)'].join('\n');
    const res = removeWorkflowFromReadme(md, '003_WD010_실험.labnote.md');
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain('003_WD010_실험.labnote.md');
  });

  // #95
  it('matches entries whose label has brackets, escaped or not', () => {
    const md = [
      '## Related Workflows',
      '',
      '- [ ] [WD010 Design LOC-01]](./004_WD010_Design_LOC-01.labnote.md)',
      '- [ ] [WD010 Design LOC-01\\]](./004_WD010_Design_LOC-01.labnote.md)',
      '- [ ] [WB045 \\[재\\] 겨울](./005_WB045_재_겨울.labnote.md)',
    ].join('\n');
    expect(removeWorkflowFromReadme(md, '004_WD010_Design_LOC-01.labnote.md').content).toBe(
      ['## Related Workflows', '', '- [ ] [WB045 \\[재\\] 겨울](./005_WB045_재_겨울.labnote.md)'].join('\n')
    );
    expect(removeWorkflowFromReadme(md, '005_WB045_재_겨울.labnote.md').content).not.toContain('005_');
  });
});

// #412: a file name with a space is linked as `%20`.
describe('removeWorkflowFromReadme with a space in the name', () => {
  it('removes the %20 entry', () => {
    const readme = README.replace('./001_WD010_Design.labnote.md', './001_WD010_Design%201.labnote.md');
    const res = removeWorkflowFromReadme(readme, '001_WD010_Design 1.labnote.md');
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain('Design%201');
  });
});
