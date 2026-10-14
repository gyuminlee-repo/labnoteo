// Globals convention (no `import ... from 'vitest'`) — see sampleStorage.test.ts.
import { planReferenceInsert } from '../sample/referenceInsert';

const TYPES = ['DNA', 'RNA', 'Other'] as const;
const REF = 'DNA-1;pUC19';

/** Apply a plan to produce the resulting document text. */
function apply(text: string, cursor: number, ref = REF): string {
  const plan = planReferenceInsert(text, cursor, ref, TYPES);
  return text.slice(0, plan.offset) + plan.text + text.slice(plan.offset);
}

describe('planReferenceInsert', () => {
  describe('rule 1: front matter / above first heading -> end of document', () => {
    it('appends at the end when the cursor is inside front matter', () => {
      const text = '---\ntitle: x\n---\n\n## [WT1] t\nbody\n';
      // Cursor on the `title:` line (offset 6 is inside front matter).
      expect(apply(text, 6)).toBe(text + 'DNA-1;pUC19\n');
    });

    it('appends at the end when the cursor is at the first heading start (no blank line)', () => {
      const text = '---\nfm: 1\n---\n## [WT1] t\nbody';
      // Heading line begins at offset 14 (right after the closing `---\n`).
      expect(apply(text, 14)).toBe(text + '\nDNA-1;pUC19\n');
    });

    it('adds a trailing newline relative to existing end-of-file newline', () => {
      const withNl = '---\nfm: 1\n---\n';
      expect(apply(withNl, 5)).toBe(withNl + 'DNA-1;pUC19\n');
    });
  });

  describe('rule 2: cursor on a heading line -> the next line', () => {
    it('inserts after the heading, not at the start of its line', () => {
      const text = '---\nfm: 1\n---\n## [WT1] t\nbody';
      // Offset 16 is inside the heading text.
      expect(apply(text, 16)).toBe('---\nfm: 1\n---\n## [WT1] t\nDNA-1;pUC19\nbody');
    });

    it('handles a heading on the last line without a trailing newline', () => {
      const text = '# Title';
      expect(apply(text, 3)).toBe('# Title\nDNA-1;pUC19\n');
    });
  });

  describe('rule 3: cursor on an existing reference -> end of that line', () => {
    it('appends to the line end with a leading space, never splitting the reference', () => {
      const text = 'body\nused Other-123;AA here\nmore';
      // Offset 13 is inside `Other-123`.
      expect(apply(text, 13)).toBe('body\nused Other-123;AA here DNA-1;pUC19\nmore');
    });

    it('does not double a trailing space', () => {
      const text = 'Other-7;x ';
      expect(apply(text, 3)).toBe('Other-7;x DNA-1;pUC19');
    });

    // #55 retest: the cursor inside the alias split it (`두번|째시약`).
    it('treats the `;alias` tail as part of the reference', () => {
      const text = '## Method\n사용 Other-1;두번째시약 끝\nmore';
      const at = text.indexOf('째시약');
      expect(apply(text, at)).toBe('## Method\n사용 Other-1;두번째시약 끝 DNA-1;pUC19\nmore');
    });

    it('stops the alias tail at whitespace', () => {
      const text = '## M\nOther-1;두번째 시약 here';
      const at = text.indexOf('시약');
      expect(apply(text, at)).toBe('## M\nOther-1;두번째 DNA-1;pUC19 시약 here');
    });
  });

  describe('rule 3: cursor on a sample definition line -> the next line', () => {
    it('inserts below the definition wherever the cursor is on it', () => {
      const text = '## M\n@other;Other-1;두번째시약;설명 문장\nmore';
      for (const word of ['Other-1', '두번째', '설명', '문장']) {
        expect(apply(text, text.indexOf(word) + 1)).toBe(
          '## M\n@other;Other-1;두번째시약;설명 문장\nDNA-1;pUC19\nmore'
        );
      }
    });

    it('adds a line break when the definition is the last line', () => {
      const text = '## M\n@Other;Other-1;x';
      expect(apply(text, text.length)).toBe('## M\n@Other;Other-1;x\nDNA-1;pUC19');
    });

    // #55 retest: a definition after other text was appended to, and the new
    // reference was read back into its description.
    it('also protects a definition that follows other text on the line', () => {
      const line = '오늘 쓴 것: @other;Other-12;넷째정의;넷째 설명';
      const text = `## M\n${line}\nmore`;
      for (const word of ['오늘', 'Other-12', '넷째정의', '설명']) {
        expect(apply(text, text.indexOf(word) + 1)).toBe(`## M\n${line}\nDNA-1;pUC19\nmore`);
      }
      expect(apply(text, text.indexOf('\nmore'))).toBe(`## M\n${line}\nDNA-1;pUC19\nmore`);
    });

    it('adds a line break when that definition is on the last line', () => {
      const text = '## M\n정의줄: @Other;Other-1;정의시약;정의 설명';
      expect(apply(text, text.length)).toBe(`${text}\nDNA-1;pUC19`);
    });

    it('recognises a custom Hangul type definition mid-line', () => {
      const text = '## M\n배지는 @배지;배지-3;LB;기본 배지\nmore';
      const plan = planReferenceInsert(text, text.indexOf('LB'), REF, [...TYPES, '배지']);
      expect(text.slice(0, plan.offset) + plan.text + text.slice(plan.offset)).toBe(
        '## M\n배지는 @배지;배지-3;LB;기본 배지\nDNA-1;pUC19\nmore'
      );
    });
  });

  describe('rule 4: at the cursor with neighbour-aware padding', () => {
    it('pads both sides between word characters', () => {
      expect(apply('abc', 2)).toBe('ab DNA-1;pUC19 c');
    });

    // #50 retest: Hangul neighbours fused with the id (`시약은DNA-1;pUC19여기`).
    it('pads both sides between Hangul characters', () => {
      const text = '## M\n사용한시약은여기에';
      const at = text.indexOf('여기');
      expect(apply(text, at)).toBe('## M\n사용한시약은 DNA-1;pUC19 여기에');
    });

    it('does not pad on an empty line', () => {
      expect(apply('line1\n\nline3', 6)).toBe('line1\nDNA-1;pUC19\nline3');
    });

    it('does not pad against a non-word symbol', () => {
      // After `(` (offset 1): before is `(` (no pad), after is `)` (no pad).
      expect(apply('()', 1)).toBe('(DNA-1;pUC19)');
    });
  });

  // #72: a table row must keep its cells.
  describe('table rows -> inside the cells', () => {
    const head = '## 결과\n| 시료 | 비고 |\n|---|---|\n';

    it('inserts at the cursor inside a cell', () => {
      const text = `${head}| 첫 | ok |`;
      const at = text.indexOf('첫') + 1;
      expect(apply(text, at)).toBe(`${head}| 첫 DNA-1;pUC19 | ok |`);
    });

    it('inserts right before a reference under the cursor', () => {
      const text = `${head}| RNA-2;mix | ok |`;
      const at = text.indexOf('mix') + 1;
      expect(apply(text, at)).toBe(`${head}| DNA-1;pUC19 RNA-2;mix | ok |`);
    });

    it('inserts right before a definition, even past a space in its alias', () => {
      const text = `${head}| @rna;RNA-2;my mix | ok |`;
      const at = text.indexOf('mix |') + 1;
      expect(apply(text, at)).toBe(`${head}| DNA-1;pUC19 @rna;RNA-2;my mix | ok |`);
    });

    it('moves a cursor past the last pipe back inside the row', () => {
      const text = `${head}| a | ok |`;
      expect(apply(text, text.length)).toBe(`${head}| a | ok DNA-1;pUC19 |`);
    });

    it('moves a cursor before the first pipe inside the row', () => {
      const text = `${head}| a | ok |`;
      expect(apply(text, head.length)).toBe(`${head}| DNA-1;pUC19 a | ok |`);
    });

    it('treats an escaped pipe as part of the reference', () => {
      const text = `${head}| RNA-2;a\\|b | ok |`;
      const at = text.indexOf('b |');
      expect(apply(text, at, 'DNA-1;x\\|y')).toBe(`${head}| DNA-1;x\\|y RNA-2;a\\|b | ok |`);
    });
  });

  describe('edge cases', () => {
    it('ignores a `#` line inside a fenced code block (not a heading)', () => {
      const text = '## Real\ntext\n```bash\n# comment\n```\nmore';
      // Cursor at the start of `# comment` (offset 21).
      const at = text.indexOf('# comment');
      expect(apply(text, at)).toBe(
        '## Real\ntext\n```bash\nDNA-1;pUC19# comment\n```\nmore'
      );
    });

    it('a note without any heading inserts at the cursor (rule 1 applies only in front matter)', () => {
      const text = 'just some text here';
      // before=`t` (word) pads a leading space; after=` ` needs none.
      expect(apply(text, 4)).toBe('just DNA-1;pUC19 some text here');
    });

    it('handles an empty document', () => {
      expect(apply('', 0)).toBe('DNA-1;pUC19');
    });
  });
});
