import {
  findDuplicateNoteIds,
  generateNoteId,
  isValidNoteId,
  noteIdUnwritable,
  readNoteId,
  readRawNoteId,
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
  // A labnote_id continued on the next lines (or a block scalar, or a quoted
  // value over lines) is no valid ID: YAML reads the whole value.
  it.each([
    ['an indented continuation line', '---\nlabnote_id: LN-7K3M9QX2\n  old\n---\nbody\n'],
    ['a list under an empty value', '---\nlabnote_id:\n- LN-7K3M9QX2\n---\nbody\n'],
    ['a folded block', '---\nlabnote_id: >-\n  LN-7K3M9QX2\n---\nbody\n'],
    ['a literal block', '---\nlabnote_id: |\n  LN-7K3M9QX2\n---\nbody\n'],
    ['a quoted value over lines', '---\nlabnote_id: "LN-7K3M9QX2\n  old"\n---\nbody\n'],
  ])('reads no ID from a value on several lines: %s', (_name, md) => {
    expect(readNoteId(md)).toBeUndefined();
  });

  // A `- ` line under a key with a value is a YAML error, not more of the value: read as B7 did (R1).
  it('reads the one-line ID with a list line below it', () => {
    expect(readNoteId('---\nlabnote_id: LN-7K3M9QX2\n- old\n---\nbody\n')).toBe('LN-7K3M9QX2');
  });

  it.each([
    ['plain', '---\nlabnote_id: LN-7K3M9QX2\nother: 1\n---\n'],
    ['single-quoted', "---\nlabnote_id: 'LN-7K3M9QX2'\n---\n"],
    ['double-quoted', '---\nlabnote_id: "LN-7K3M9QX2"\n---\n'],
  ])('reads a one-line %s ID as before', (_name, md) => {
    expect(readNoteId(md)).toBe('LN-7K3M9QX2');
  });

  // setNoteId rewrites only a labnote_id on one line as a plain or quoted
  // scalar; any other shape is left as it is (the caller checks the result).
  it.each([
    ['plain', '---\nlabnote_id: LN-OLD\nother: 1\n---\n', '---\nlabnote_id: LN-NEW00000\nother: 1\n---\n'],
    ['single-quoted', "---\nlabnote_id: 'LN-OLD'\n---\n", '---\nlabnote_id: LN-NEW00000\n---\n'],
    ['double-quoted', '---\nlabnote_id: "LN-OLD"\n---\n', '---\nlabnote_id: LN-NEW00000\n---\n'],
    ['empty', '---\nlabnote_id:\nother: 1\n---\n', '---\nlabnote_id: LN-NEW00000\nother: 1\n---\n'],
  ])('rewrites a one-line %s value', (_name, md, want) => {
    expect(setNoteId(md, 'LN-NEW00000')).toBe(want);
  });

  // A value that ends on its line is rewritten as before, tag, anchor or not.
  it.each([
    ['tagged', '---\nlabnote_id: !!str LN-7K3M9QX2\n---\nbody\n', '---\nlabnote_id: LN-NEW00000\n---\nbody\n'],
    ['anchored', '---\nlabnote_id: &i LN-OLD\nz: *i\n---\n', '---\nlabnote_id: LN-NEW00000\nz: *i\n---\n'],
    ['alias', '---\na: &i LN-OLD\nlabnote_id: *i\n---\n', '---\na: &i LN-OLD\nlabnote_id: LN-NEW00000\n---\n'],
    ['flow list', '---\nlabnote_id: [LN-OLD]\n---\n', '---\nlabnote_id: LN-NEW00000\n---\n'],
    ['tagged quote', '---\nlabnote_id: !!str "LN-OLD"\n---\n', '---\nlabnote_id: LN-NEW00000\n---\n'],
    ['quote with a comment right after it', '---\nlabnote_id: "old"#comment\n---\n', '---\nlabnote_id: LN-NEW00000\n---\n'],
    ['single quote with a comment right after it', "---\nlabnote_id: 'old'#comment\n---\n", '---\nlabnote_id: LN-NEW00000\n---\n'],
  ])('rewrites a one-line %s value as before', (_name, md, want) => {
    expect(setNoteId(md, 'LN-NEW00000')).toBe(want);
    expect(readNoteId(md)).toBeUndefined();
  });

  // An indented comment under the key does not continue the value.
  it.each([
    ['plain', '---\nlabnote_id: ln-7k3m9qx2\n  # barcode\n---\nbody\n', '---\nlabnote_id: LN-NEW00000\n  # barcode\n---\nbody\n'],
    ['quoted', '---\nlabnote_id: "ln-7k3m9qx2"\n  # barcode\n---\nbody\n', '---\nlabnote_id: LN-NEW00000\n  # barcode\n---\nbody\n'],
    ['empty', '---\nlabnote_id:\n  # barcode\n---\nbody\n', '---\nlabnote_id: LN-NEW00000\n  # barcode\n---\nbody\n'],
    ['CRLF', '---\r\nlabnote_id: ln-7k3m9qx2\r\n  # barcode\r\n---\r\nbody\r\n', '---\r\nlabnote_id: LN-NEW00000\r\n  # barcode\r\n---\r\nbody\r\n'],
  ])('rewrites a %s value with an indented comment below it', (_name, md, want) => {
    expect(setNoteId(md, 'LN-NEW00000')).toBe(want);
  });

  // `-` followed by a non-ASCII space starts a key, not a list item under the ID.
  it.each([['NBSP', '\u00a0'], ['em space', '\u2003'], ['ideographic space', '\u3000']])(
    'reads and rewrites the ID before a "-%s" key',
    (_name, sp) => {
      const md = `---\nlabnote_id: LN-7K3M9QX2\n-${sp}other: keep\n---\nbody\n`;
      expect(readNoteId(md)).toBe('LN-7K3M9QX2');
      expect(setNoteId(md, 'LN-00000001')).toBe(`---\nlabnote_id: LN-00000001\n-${sp}other: keep\n---\nbody\n`);
    }
  );

  // A key indented with a non-ASCII space is a key of its own, not a continuation.
  it.each([['NBSP', '\u00a0'], ['em space', '\u2003'], ['ideographic space', '\u3000']])(
    'reads the ID before a key indented with %s',
    (_name, sp) => {
      expect(readNoteId(`---\nlabnote_id: LN-7K3M9QX2\n${sp}other: keep\n---\nbody\n`)).toBe('LN-7K3M9QX2');
    }
  );

  it.each([['NBSP', '\u00a0'], ['em space', '\u2003'], ['ideographic space', '\u3000']])(
    'rewrites a value followed by a key indented with %s',
    (_name, sp) => {
      const md = `---\nlabnote_id: LN-7K3M9QX2\n${sp}other: keep\n---\nbody\n`;
      expect(setNoteId(md, 'LN-00000001')).toBe(`---\nlabnote_id: LN-00000001\n${sp}other: keep\n---\nbody\n`);
    }
  );

  it.each([
    ['folded', '---\ntitle: T\nlabnote_id: >-\n  LN-OLD\nother: 1\n---\nbody\n'],
    ['literal', '---\nlabnote_id: |\n  LN-OLD\n---\n'],
    ['continued plain', '---\nlabnote_id: LN-OLD\n  more\n---\n'],
    ['quoted over lines', '---\nlabnote_id: "LN-OLD\n  more"\n---\n'],
    ['tagged block', '---\nlabnote_id: !!str |\n  LN-OLD\n---\n'],
    ['anchored block', '---\nlabnote_id: &a >-\n  LN-OLD\n---\n'],
    ['tagged quote over lines', '---\nlabnote_id: !!str "LN-OLD\n  x"\n---\n'],
    ['block list', '---\nlabnote_id:\n  - LN-OLD\n---\n'],
  ])('leaves a %s value as it is', (_name, md) => {
    expect(setNoteId(md, 'LN-NEW00000')).toBe(md);
  });

  const note = '---\ntitle: WD010 Design\nexperimenter: Kim\n---\n\n## [WD010 Design]\n';

  // #478
  it('reads a malformed value as written, but not as an ID', () => {
    const odd = "---\nlabnote_id: ' ln-r4w7tz04 '\n---\n";
    expect(readRawNoteId(odd)).toBe('ln-r4w7tz04');
    expect(readNoteId(odd)).toBeUndefined();
    expect(readRawNoteId('---\nlabnote_id:\n---\n')).toBeUndefined();
    expect(readRawNoteId(note)).toBeUndefined();
  });

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

// One judgment: a note never has an ID it cannot be given, and setNoteId writes exactly
// where the value is writable (L2), whatever the first value and the line below it.
describe('readNoteId, noteIdUnwritable and setNoteId agree', () => {
  const firsts = ['', ' ', '\t', ' # c', " ''", ' ""', ' LN-7K3M9QX2', ' "LN-7K3M9QX2"', " 'LN-7K3M9QX2'", ' |', ' >-', ' "LN-7K3M9QX2', ' LN-7K3M9QX2 # c'];
  const nexts = ['\tLN-7K3M9QX2', '  LN-7K3M9QX2', '\tmore', '  more', '- LN-7K3M9QX2', '- more', '', '  # c', 'title: T', '-'];
  it('on every combination, LF and CRLF', () => {
    const bad: string[] = [];
    for (const nl of ['\n', '\r\n']) for (const f of firsts) for (const x of nexts) for (const after of [[], ['end_date: 1']]) {
      const md = ['---', `labnote_id:${f}`, x, ...after, '---', 'body', ''].join(nl);
      const unwritable = noteIdUnwritable(md);
      const took = readNoteId(setNoteId(md, 'LN-00000000')) === 'LN-00000000';
      if ((readNoteId(md) && unwritable) || unwritable === took) bad.push(md);
    }
    expect(bad).toEqual([]);
  });
});
