import { describe, it, expect } from 'vitest';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { insertWorkflowChecklistEntries } from '../lib/workflowStructure';

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
