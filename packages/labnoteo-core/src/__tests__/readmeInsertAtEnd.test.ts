/**
 * E1: the first entry added to a Related Workflows section that ends the README is
 * placed as main (d7461be) places it, a blank line below the heading or the instruction
 * blockquote, and the README keeps its final line break, which main lost.
 */
import { describe, it, expect } from 'vitest';
import { insertWorkflowChecklistEntries } from '../lib/workflowStructure';

const A = { done: false, title: 'A', fileName: '001_WD010_A.labnote.md' };
const ENTRY = '- [ ] [A](./001_WD010_A.labnote.md)';
const cases = [
  ['the heading', ['## Related Workflows', ''], ['## Related Workflows', '', ENTRY, '']],
  ['the instruction blockquote', ['## Related Workflows', '> Instructions', ''], ['## Related Workflows', '> Instructions', '', ENTRY, '']],
  ['a blank line', ['## Related Workflows', '', ''], ['## Related Workflows', '', '', ENTRY, '']],
] as const;
const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;

describe('the first entry of a Related Workflows section at the end of the README', () => {
  it.each(cases.flatMap(([name, md, out]) => endings.map(([n, nl]) => [name, n, md.join(nl), out.join(nl)] as const)))(
    'goes a blank line below %s and the final line break stays (%s)',
    (_name, _n, md, out) => {
      expect(insertWorkflowChecklistEntries(md, [A])).toBe(out);
    }
  );
});
