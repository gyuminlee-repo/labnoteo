import { describe, it, expect } from 'vitest';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { insertWorkflowChecklistEntries } from '../lib/workflowStructure';
import { htmlBlockLines } from '../lib/readmeFences';

// A backtick run in an HTML block is HTML (CommonMark), no fence: it pairs with no fence below,
// so it hides no heading and makes no entry code.
describe('a README with backticks in an HTML block', () => {
  const head = '---\ndescription: |\n  ```\n---\n## Related Workflows\n<div>\n```\n</div>\n\n## Notes\n';

  it('keeps an entry in a code example of the next section', () => {
    const md = `${head}\`\`\`\n- [ ] [A](./001_WD010_A.labnote.md)\n\`\`\`\n`;
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });

  it('adds an entry next to the last one, not into the code example below it', () => {
    const section = '---\ndescription: |\n  ```\n---\n## Related Workflows\n<div>\n```\n</div>\n\n';
    const md = `${section}- [ ] [A](./001_WD010_A.labnote.md)\n\`\`\`\ncode\n\`\`\`\n`;
    const out = insertWorkflowChecklistEntries(md, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }]);
    expect(out).toBe(`${section}- [ ] [A](./001_WD010_A.labnote.md)\n- [ ] [D](./004_WD010_D.labnote.md)\n\`\`\`\ncode\n\`\`\`\n`);
  });
});

// CommonMark HTML block starts: an autolink, an inline tag in text or `a < b` starts none, and a
// lone tag (type 7) does not interrupt a paragraph.
describe('lines that start no HTML block', () => {
  it.each([
    ['<https://example.org>'],
    ['<a@b.co>'],
    ['<b>bold</b> text'],
    ['a < b'],
    ['<span>x</span>'],
  ])('%s', line => {
    expect(htmlBlockLines([line, '## Notes'])).toEqual([false, false]);
  });

  it('a lone tag after paragraph text is text; after a blank line it starts a block', () => {
    expect(htmlBlockLines(['para', '<custom-tag>', 'x'])).toEqual([false, false, false]);
    expect(htmlBlockLines(['', '<custom-tag>', 'x', '', 'y'])).toEqual([false, true, true, false, false]);
  });

  it('a comment ends on its own line, a div at the blank line', () => {
    expect(htmlBlockLines(['<!-- one -->', 'x'])).toEqual([true, false]);
    expect(htmlBlockLines(['<div>', 'x', '', 'y'])).toEqual([true, true, false, false]);
  });

  it('an autolink hides no heading: the next section keeps its entry', () => {
    const md = '## Related Workflows\n<https://example.org>\n## Notes\n\n- [ ] [A](./001_WD010_A.labnote.md)\n';
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });
});
