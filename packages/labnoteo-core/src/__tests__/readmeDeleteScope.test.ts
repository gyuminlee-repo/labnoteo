/**
 * D3: deleting a workflow from the README removes its entry only from a section the
 * checklist is read from, as main (d7461be) does: a heading in a closed fence starts no
 * section, an entries-based pick is made only where the add path makes it too, and a fence
 * indented four spaces (no fence to CommonMark) hides no heading. The entry stays in each
 * case below, and parse and add do not take its line for a checklist entry either.
 */
import { describe, it, expect } from 'vitest';
import { removeWorkflowFromReadme } from '../lib/workflowDelete';
import { parseWorkflowChecklistFromReadme } from '../lib/workflowStructure';

const A = '- [ ] [A](./001_WD010_A.labnote.md)';
const B = '- [x] [B](./002_WD010_B.labnote.md)';
const cases = [
  ['a fenced Related Workflows, then A under ## Notes', ['# Exp', '', '```md', '## Related Workflows', '```', '', '## Notes', A, '']],
  ['every heading in a closed fence', ['```md', '## 관련 워크플로', '## 🗂️ Related Workflows', '```', A, '']],
  ['the real section, then a fenced example heading under ## Notes', ['## Related Workflows', B, '', '## Notes', '```md', '## Related Workflows', '```', A, '']],
  ['a four-space fence around a real ## Notes', ['## Related Workflows', B, '    ```md', '## Notes', '    ```', A, '']],
] as const;
const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;

describe('workflow deletion stays in the sections the checklist is read from', () => {
  it.each(cases.flatMap(([name, lines]) => endings.map(([n, nl]) => [name, n, lines.join(nl)] as const)))('%s (%s)', (_name, _n, md) => {
    expect(parseWorkflowChecklistFromReadme(md).map(e => e.fileName)).not.toContain('001_WD010_A.labnote.md');
    expect(removeWorkflowFromReadme(md, '001_WD010_A.labnote.md')).toEqual({ changed: false, content: md });
  });
});
