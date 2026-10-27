/**
 * Any web page can open an `obsidian://labnoteo-open` link, so only a plain
 * vault-relative Markdown path and a sample type this vault has get through.
 */
import { describe, it, expect } from 'vitest';
import { openPosition, parseOpenRequest } from '../../src/labnoteOpenUri';

const TYPES = ['DNA', 'Plasmid', 'Strain'];
const FILE = 'labnote/001_GFP/002_WB140.labnote.md';

describe('parseOpenRequest', () => {
  it('reads a note link with a sample and a heading', () => {
    expect(
      parseOpenRequest({ vault: 'lab', file: ` ${FILE} `, type: 'dna', sample: ' DNA-1 ', heading: ' Methods ' }, TYPES)
    ).toEqual({ file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Methods' });
  });

  it('reads a note link alone', () => {
    expect(parseOpenRequest({ file: FILE }, TYPES)).toEqual({ file: FILE });
  });

  it('refuses paths outside the vault or not a Markdown note', () => {
    for (const file of [
      '',
      '/etc/passwd.md',
      'C:/Users/x/note.md',
      '../outside.md',
      'labnote/../../x.md',
      './x.md',
      'labnote/run.sh',
      'a'.repeat(1025) + '.md',
    ]) {
      expect(parseOpenRequest({ file }, TYPES), file).toBeUndefined();
    }
  });

  it('normalizes Windows separators', () => {
    expect(parseOpenRequest({ file: 'labnote\\001\\n.labnote.md' }, TYPES)?.file).toBe('labnote/001/n.labnote.md');
  });

  it('needs a known type and an id together', () => {
    expect(parseOpenRequest({ file: FILE, type: 'Gene', sample: 'G-1' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, type: 'DNA' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, sample: 'DNA-1' }, TYPES)).toBeUndefined();
    expect(parseOpenRequest({ file: FILE, type: 'DNA', sample: 'x'.repeat(201) }, TYPES)).toBeUndefined();
  });

  it('refuses an overlong heading', () => {
    expect(parseOpenRequest({ file: FILE, heading: 'h'.repeat(301) }, TYPES)).toBeUndefined();
  });
});

describe('openPosition', () => {
  const text = [
    '# Note', // 0
    '## Methods', // 1
    'Mix @DNA;DNA-1 with buffer.', // 2
    '## Results', // 3
    'Band of @DNA;DNA-1 at 3 kb.', // 4
  ].join('\n');

  it('prefers the reference under the asked heading', () => {
    const at = openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Note › Results' }, []);
    expect(at.line).toBe(4);
  });

  it('falls back to the first reference, then to the top', () => {
    expect(openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-1' }, heading: 'Gone' }, []).line).toBe(2);
    expect(openPosition(text, { file: FILE, sample: { type: 'DNA', id: 'DNA-9' } }, [])).toEqual({ line: 0, ch: 0 });
    expect(openPosition(text, { file: FILE }, [])).toEqual({ line: 0, ch: 0 });
  });
});
