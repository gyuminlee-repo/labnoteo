// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { findSampleReferenceAt } from '../sample/sampleSuggest';

const TYPES = ['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware'];

describe('findSampleReferenceAt', () => {
  it('returns the reference when the column is inside an id', () => {
    const line = 'used DNA-123;sampleA for the assembly';
    // "DNA-123" starts at index 5; pick a column inside it.
    const hit = findSampleReferenceAt(line, 8, TYPES);
    expect(hit).toEqual({ type: 'DNA', id: 'DNA-123', start: 5, end: 12 });
  });

  it('matches at the boundary column (end inclusive)', () => {
    const line = 'DNA-123 done';
    expect(findSampleReferenceAt(line, 0, TYPES)?.id).toBe('DNA-123');
    expect(findSampleReferenceAt(line, 7, TYPES)?.id).toBe('DNA-123');
  });

  it('returns null when the column is outside any id', () => {
    const line = 'used DNA-123 here';
    expect(findSampleReferenceAt(line, 2, TYPES)).toBeNull();
    expect(findSampleReferenceAt(line, 15, TYPES)).toBeNull();
  });

  it('picks the id under the cursor among multiple references', () => {
    const line = 'DNA-1 and RNA-2 and Plasmid-3';
    expect(findSampleReferenceAt(line, 11, TYPES)?.id).toBe('RNA-2');
    expect(findSampleReferenceAt(line, 22, TYPES)?.id).toBe('Plasmid-3');
  });

  // #136: the alias is part of the reference too.
  it('finds the reference from inside its alias, with the whole span', () => {
    const line = '시료 Reagent-1777;Tris-HCl pH 8.0 사용';
    const at = line.indexOf('HCl');
    expect(findSampleReferenceAt(line, at, TYPES)).toEqual({
      type: 'Reagent',
      id: 'Reagent-1777',
      start: 3,
      end: line.length,
    });
  });

  it('finds the reference right after its alias', () => {
    const line = 'DNA-123;sampleA';
    expect(findSampleReferenceAt(line, line.length, TYPES)?.id).toBe('DNA-123');
  });

  it('picks the reference whose alias the cursor is in when a line has two', () => {
    const line = 'Reagent-1;첫시약 Reagent-2;둘째시약';
    expect(findSampleReferenceAt(line, line.indexOf('첫'), TYPES)?.id).toBe('Reagent-1');
    expect(findSampleReferenceAt(line, line.indexOf('둘째'), TYPES)?.id).toBe('Reagent-2');
  });

  it('opens the reference from a sentence written after it, as the alias reads it', () => {
    const line = 'used DNA-123;sampleA for the assembly';
    expect(findSampleReferenceAt(line, line.indexOf('assembly'), TYPES)?.id).toBe('DNA-123');
  });
});
