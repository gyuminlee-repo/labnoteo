import {
  findDuplicateNoteIds,
  generateNoteId,
  isValidNoteId,
  readNoteId,
  setNoteId,
} from '../lib/noteId';
import { createWorkflowContent } from '../lib/workflowStructure';
import { parseFrontMatterYaml } from '../sections/frontMatter';

describe('generateNoteId', () => {
  it('makes LN- plus 8 Crockford base32 characters', () => {
    for (let i = 0; i < 50; i++) expect(isValidNoteId(generateNoteId())).toBe(true);
  });

  it('encodes the random bytes', () => {
    expect(generateNoteId(n => new Uint8Array(n))).toBe('LN-00000000');
    expect(generateNoteId(n => new Uint8Array(n).fill(255))).toBe('LN-ZZZZZZZZ');
  });

  it('rejects look-alike letters and other shapes', () => {
    for (const bad of ['LN-0000000I', 'LN-0000000O', 'LN-0000000U', 'LN-0000000', 'ln-00000000', 'EXP-001', 42]) {
      expect(isValidNoteId(bad)).toBe(false);
    }
  });
});

describe('readNoteId / setNoteId', () => {
  const note = '---\ntitle: WD010 Design\nexperimenter: Kim\n---\n\n## [WD010 Design]\n';

  it('inserts the ID after the title and reads it back', () => {
    const out = setNoteId(note, 'LN-7K3M9QX2');
    expect(out).toBe('---\ntitle: WD010 Design\nlabnote_id: LN-7K3M9QX2\nexperimenter: Kim\n---\n\n## [WD010 Design]\n');
    expect(readNoteId(out)).toBe('LN-7K3M9QX2');
    expect(parseFrontMatterYaml(out).frontMatter.labnote_id).toBe('LN-7K3M9QX2');
  });

  it('replaces an existing ID in place and keeps CRLF', () => {
    const crlf = setNoteId(note, 'LN-7K3M9QX2').replace(/\n/g, '\r\n');
    const out = setNoteId(crlf, 'LN-AAAAAAAA');
    expect(out).toContain('labnote_id: LN-AAAAAAAA\r\nexperimenter');
    expect(out.match(/labnote_id/g)).toHaveLength(1);
    expect(setNoteId(out, 'LN-AAAAAAAA')).toBe(out);
  });

  it('reads a quoted ID and ignores an invalid one', () => {
    expect(readNoteId("---\nlabnote_id: 'LN-7K3M9QX2'\n---\n")).toBe('LN-7K3M9QX2');
    expect(readNoteId('---\nlabnote_id: hello\n---\n')).toBeUndefined();
    expect(readNoteId('labnote_id: LN-7K3M9QX2\n')).toBeUndefined();
  });

  it('gives a note without front matter a block of its own', () => {
    expect(setNoteId('# Hi\n', 'LN-7K3M9QX2')).toBe('---\nlabnote_id: LN-7K3M9QX2\n---\n\n# Hi\n');
  });

  it('keeps a title continued on the next lines together', () => {
    const out = setNoteId('---\ntitle: >\n  long\n  title\n---\n', 'LN-7K3M9QX2');
    expect(out).toBe('---\nlabnote_id: LN-7K3M9QX2\ntitle: >\n  long\n  title\n---\n');
  });
});

describe('workflow template', () => {
  it('gives each new workflow note its own labnote_id', () => {
    const wf = { id: 'WD010', name: 'Design', description: 'desc' };
    const a = readNoteId(createWorkflowContent(wf, 'Kim'));
    const b = readNoteId(createWorkflowContent(wf, 'Kim'));
    expect(isValidNoteId(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(readNoteId(createWorkflowContent(wf, 'Kim', undefined, { noteId: 'LN-7K3M9QX2' }))).toBe('LN-7K3M9QX2');
  });
});

describe('findDuplicateNoteIds', () => {
  it('lists only IDs shared by several notes', () => {
    const dup = findDuplicateNoteIds([
      { path: 'a', id: 'LN-1' },
      { path: 'b', id: 'LN-2' },
      { path: 'c', id: 'LN-1' },
    ]);
    expect([...dup]).toEqual([['LN-1', ['a', 'c']]]);
  });
});
