import { describe, it, expect } from 'vitest';
import { tableBlockEnd } from '../../src/tableCellTarget';

// #196
describe('tableBlockEnd', () => {
  const text = ['intro', '', '| ID | Alias |', '| --- | --- |', '| DNA-1 | a |', '', 'after'].join('\n');
  const tableEnd = text.indexOf('| DNA-1 | a |') + '| DNA-1 | a |'.length;

  it('finds the end of the table from any of its rows', () => {
    expect(tableBlockEnd(text, text.indexOf('| ID'))).toBe(tableEnd);
    expect(tableBlockEnd(text, text.indexOf('--- |') + 2)).toBe(tableEnd);
    expect(tableBlockEnd(text, tableEnd)).toBe(tableEnd);
  });

  it('returns the end of the line outside a table', () => {
    expect(tableBlockEnd(text, 2)).toBe('intro'.length);
    expect(tableBlockEnd(text, text.length)).toBe(text.length);
  });

  it('handles a table at the end of the note', () => {
    const tail = 'x\n| a |\n| - |\n| 1 |';
    expect(tableBlockEnd(tail, 3)).toBe(tail.length);
  });
});
