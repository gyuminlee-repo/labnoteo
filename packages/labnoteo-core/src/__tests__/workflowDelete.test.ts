// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { insertWorkflowChecklistEntries, removeWorkflowChecklistEntries } from '../lib/workflowStructure';

// A blank line in a code example stays when an entry next to it goes (the entry goes as before).
describe('removing an entry next to blank lines in code', () => {
  // A list fence's closer, read line by line, closes nothing here: the blank line after the
  // unclosed ~~~ is code and stays.
  it('keeps a blank line in an unclosed fence after a list fence', () => {
    const md = '## Related Workflows\n\n- [ ] [B](./002_WD010_B.labnote.md)\n- ~~~md\n  x\n  ~~~\n~~~\n\n- [ ] [A](./001_WD010_A.labnote.md)\n\nbeta\n';
    expect(removeWorkflowChecklistEntries(md, ['001_WD010_A.labnote.md'])).toBe('## Related Workflows\n\n- [ ] [B](./002_WD010_B.labnote.md)\n- ~~~md\n  x\n  ~~~\n~~~\n\n\nbeta\n');
  });

  const md = '## Related Workflows\n```text\nalpha\n\n- [ ] [A](./001_WD010_A.labnote.md)\n\nbeta\n```\n## Notes\ntail\n';
  const want = '## Related Workflows\n```text\nalpha\n\n\nbeta\n```\n## Notes\ntail\n';
  it('leaves the example to removeWorkflowFromReadme, which reads no entry in code', () => {
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });
  it('keeps them in removeWorkflowFromReadme next to an entry it removes', () => {
    const two = `${md}\n## Related Workflows\n\n- [ ] [A](./001_WD010_A.labnote.md)\n\n~~~\n\nx\n~~~\n`;
    expect(removeWorkflowFromReadme(two, '001_WD010_A.labnote.md').content).toContain('~~~\n\nx\n~~~\n');
  });
  it('keeps them in removeWorkflowChecklistEntries', () => {
    expect(removeWorkflowChecklistEntries(md, ['001_WD010_A.labnote.md'])).toBe(want);
  });
});

describe('workflow deletion section boundaries', () => {
  const entry = '- [ ] [Design](./001_WD010_Design.labnote.md)';
  const file = '001_WD010_Design.labnote.md';

  it.each(['\n', '\r\n'])('preserves other sections and fenced examples with %j', newline => {
    const section = ['## 🗂️ Related Workflows', '> Instructions  ', '~~~~md', entry, '```', entry, '~~~~', '### Nested'];
    const after = ['## Notes', entry, '# Appendix', entry, ''];
    const md = ['# Experiment', entry, ...section, entry, ...after].join(newline);
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true,
      content: ['# Experiment', entry, ...section, ...after].join(newline),
    });
  });

  // Sections are found both as in v0.130.0 (a fenced example heading takes the
  // section, as for parse and add) and with fenced headings ignored, so the
  // real section after a fenced example still loses its entry; the fenced
  // example line stays.
  it.each(['\n', '\r\n'])('removes the entry of the real section after a fenced example heading with %j', newline => {
    const head = ['# Experiment', '```md', '## Related Workflows', entry, '```', '## 🗂️ Related Workflows'];
    const md = [...head, entry, ''].join(newline);
    expect(removeWorkflowFromReadme(md, file)).toEqual({ changed: true, content: [...head, ''].join(newline) });
  });

  it('stops at the next ## heading', () => {
    const md = ['## Related Workflows', entry, '## Notes', entry].join('\n');
    expect(removeWorkflowFromReadme(md, file)).toEqual({
      changed: true, content: ['## Related Workflows', '## Notes', entry].join('\n'),
    });
  });

  // The add path writes past a `#` heading (v0.130.0), so deletion reaches there too.
  it('reads past a # heading as the add path does', () => {
    const md = ['## Related Workflows', entry, '# Notes', entry].join('\n');
    expect(removeWorkflowFromReadme(md, file)).toEqual({ changed: true, content: ['## Related Workflows', '# Notes'].join('\n') });
  });

  it.each([
    ['## Related Workflows', '## Notes', entry],
    ['```md', '## Related Workflows', entry, '```'],
    ['## Related Workflows', '```md', entry, '```'],
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

  it.each(['\n', '\r\n'])('removes the entry from the #298 fallback section the add path writes to with %j', newline => {
    const md = ['# T', '## Notes', entry, ''].join(newline);
    const added = insertWorkflowChecklistEntries(md, [{ done: true, title: 'Assay', fileName: '002_WS010_Assay.labnote.md' }]);
    expect(added).toBe(['# T', '## Notes', entry, sibling, ''].join(newline));
    expect(removeWorkflowFromReadme(md, file)).toEqual({ changed: true, content: ['# T', '## Notes', ''].join(newline) });
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
describe('removeWorkflowFromReadme and the blank lines around an entry', () => {
  const A = '- [ ] [A](./001_WD010_A.labnote.md)';
  const B = '- [ ] [B](./002_WD020_B.labnote.md)';
  const C = '- [ ] [C](./003_WD030_C.labnote.md)';
  const del = (lines: string[], f = '002_WD020_B.labnote.md'): string => removeWorkflowFromReadme(lines.join('\n'), f).content;

  it('leaves no blank line ending the README when the last entry goes', () => {
    expect(del(['## Related Workflows', A, '', B, ''])).toBe(['## Related Workflows', A, ''].join('\n'));
    expect(del(['## Related Workflows', '', A, '', B, ''])).toBe(['## Related Workflows', '', A, ''].join('\n'));
    // Without a final newline the blank line already goes as the line break of the line left last.
    expect(del(['## Related Workflows', A, '', B])).toBe(['## Related Workflows', A, ''].join('\n'));
    expect(del(['## Related Workflows', A, B, ''])).toBe(['## Related Workflows', A, ''].join('\n'));
    expect(del(['## Related Workflows', A, '', '', B, ''])).toBe(['## Related Workflows', A, ''].join('\n'));
  });

  it('leaves no two blank lines in a row where an entry went', () => {
    expect(del(['## Related Workflows', A, '', B, '', C, ''])).toBe(['## Related Workflows', A, '', C, ''].join('\n'));
    expect(del(['## Related Workflows', A, '', B, '', '## Notes', ''])).toBe(['## Related Workflows', A, '', '## Notes', ''].join('\n'));
    expect(del(['## Related Workflows', '', B, '', '## Notes', ''])).toBe(['## Related Workflows', '', '## Notes', ''].join('\n'));
    expect(removeWorkflowFromReadme(['## Related Workflows', A, '', B, '', C, ''].join('\r\n'), '002_WD020_B.labnote.md').content).toBe(
      ['## Related Workflows', A, '', C, ''].join('\r\n')
    );
  });

  it('keeps blank lines the entry did not touch', () => {
    expect(del(['## Related Workflows', A, B, '', C, ''])).toBe(['## Related Workflows', A, '', C, ''].join('\n'));
    expect(del(['## Related Workflows', A, '', '', B, C, ''])).toBe(['## Related Workflows', A, '', '', C, ''].join('\n'));
  });
});

describe('removeWorkflowFromReadme with a space in the name', () => {
  it('removes the %20 entry', () => {
    const readme = README.replace('./001_WD010_Design.labnote.md', './001_WD010_Design%201.labnote.md');
    const res = removeWorkflowFromReadme(readme, '001_WD010_Design 1.labnote.md');
    expect(res.changed).toBe(true);
    expect(res.content).not.toContain('Design%201');
  });
});
