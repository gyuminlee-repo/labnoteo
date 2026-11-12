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
    expect(htmlBlockLines(['', '<custom-tag>', 'x', '', 'y'])).toEqual([false, true, true, true, false]);
  });

  it('a comment ends on its own line, a div at the blank line (marked: a line before it joins the div)', () => {
    expect(htmlBlockLines(['<!-- one -->', 'x'])).toEqual([true, false]);
    expect(htmlBlockLines(['<div>', 'x', '', 'y'])).toEqual([true, true, true, false]);
  });

  it('adds an entry past the blank line ending a div, not into the div', () => {
    const md = '## Related Workflows\n<div>\n</div>\n- [ ] [A](./001_WD010_A.labnote.md)\n\n## Notes\n';
    const out = insertWorkflowChecklistEntries(md, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }]);
    expect(out).toBe('## Related Workflows\n<div>\n</div>\n- [ ] [A](./001_WD010_A.labnote.md)\n\n- [ ] [D](./004_WD010_D.labnote.md)\n## Notes\n');
  });

  it('an autolink hides no heading: the next section keeps its entry', () => {
    const md = '## Related Workflows\n<https://example.org>\n## Notes\n\n- [ ] [A](./001_WD010_A.labnote.md)\n';
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });
});

// Obsidian reads a `<div>` right after a list item's line as that item's paragraph going on, so
// the entry after its `</div>` is a list item (a checkbox in the reading view) and deletion takes
// it; the inline example in the div and the fenced one below stay. Without the list item line
// before it the block is HTML in Obsidian too, and an entry after its closer stays.
describe('a README entry right after a lone closing tag', () => {
  const div = '<div class="qa-note">\nInline `- [ ] [Build](./002_WB030_Build.labnote.md)` inside HTML, and a run ```of three``` backticks.\n</div>\n';
  const notes = '\n## Notes\nCode example:\n\n```markdown\n- [ ] [Build](./002_WB030_Build.labnote.md)\n- [ ] [Example](./009_WD010_Example.labnote.md)\n```\n\nKeep notes.\n';
  const head = '---\nstatus: ongoing\n---\n# 955_HtmlReadme_LF\n\n## Related Workflows\n- [ ] [Design](./001_WD010_Design.labnote.md)\n';

  it('deletes the entry when the div follows a list item line, as Obsidian reads no HTML block', () => {
    const md = `${head}${div}- [ ] [Build](./002_WB030_Build.labnote.md)\n${notes}`;
    expect(removeWorkflowFromReadme(md, '002_WB030_Build.labnote.md')).toEqual({ changed: true, content: `${head}${div}${notes}` });
  });

  it('keeps the line after a lone closer in a <pre> block: there it is preformatted text', () => {
    const md = '## Related Workflows\n<pre>\n</div>\n- [ ] [A](./001_WD010_A.labnote.md)\n</pre>\n';
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });

  it.each([
    ['a div after a code line', '## Related Workflows\n```\ncode\n<div>\n```\n</div>\n- [ ] [A](./001_WD010_A.labnote.md)\n```text\n## Hidden\n```\n### Sub\n~~~md\ncode\n~~~\n## 관련 워크플로\n\n- ~~~md\n\n  ~~~\n'],
    ['a p block after the heading', '## Related Workflows\n<p>\nnote\n</p>\n- [ ] [A](./001_WD010_A.labnote.md)\n'],
    ['a lone closer after the heading', '## Related Workflows\n</div>\n- [ ] [A](./001_WD010_A.labnote.md)\n'],
  ])('keeps the entry after the closer of %s: Obsidian reads it in the HTML block', (_name, md) => {
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });

  it('still reads the line in the HTML block for adding entries', () => {
    const lines = `${div}- [ ] [Build](./002_WB030_Build.labnote.md)\n\n`.split('\n');
    expect(htmlBlockLines(lines).slice(0, 5)).toEqual([true, true, true, true, true]);
  });
});
