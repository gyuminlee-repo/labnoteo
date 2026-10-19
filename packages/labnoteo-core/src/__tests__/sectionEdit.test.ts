// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  findSectionMatches,
  replaceSectionBody,
  replaceSectionBodyAt,
  normalizeHeadingText,
  stripRepeatedHeading,
} from '../sections/sectionEdit';

const doc = [
  '## [WD010 Design]',
  '',
  '## Related Unit Operations',
  '',
  '---',
  '',
  '### [UHW010 Spin]',
  '',
  '#### Method',
  '',
  'old method text',
  'second line',
  '',
  '#### Results',
  '',
  'old results',
  '',
  '## Conclusions and Discussion',
  '',
].join('\n');

describe('replaceSectionBody', () => {
  it('replaces the body of a #### section, stopping at the next heading', () => {
    const { ok, md } = replaceSectionBody(doc, 'Method', 'NEW method');
    expect(ok).toBe(true);
    expect(md).toContain('#### Method\n\nNEW method\n');
    // Did not swallow the following section.
    expect(md).toContain('#### Results');
    expect(md).toContain('old results');
    // Old body gone.
    expect(md).not.toContain('old method text');
    expect(md).not.toContain('second line');
  });

  it('replaces the last section up to EOF', () => {
    const { ok, md } = replaceSectionBody(doc, 'Results', 'NEW results');
    expect(ok).toBe(true);
    expect(md).toContain('#### Results\n\nNEW results\n');
    expect(md).not.toContain('old results');
    // Earlier sections untouched.
    expect(md).toContain('old method text');
  });

  it('stops a ## section at the next same-or-higher heading (keeps nested ###)', () => {
    const md = ['## A', '', 'body', '', '### sub', '', 'subbody', '', '## B', '', 'bbody', ''].join(
      '\n'
    );
    const out = replaceSectionBody(md, 'A', 'NEW');
    expect(out.ok).toBe(true);
    // Everything from A up to (but not including) `## B` replaced.
    expect(out.md).toContain('## A\n\nNEW\n');
    expect(out.md).not.toContain('### sub');
    expect(out.md).toContain('## B');
    expect(out.md).toContain('bbody');
  });

  it('returns ok=false when the heading is absent', () => {
    const out = replaceSectionBody(doc, 'Nonexistent', 'x');
    expect(out.ok).toBe(false);
    expect(out.md).toBe(doc);
  });

  it('preserves CRLF line endings', () => {
    const md = '#### Method\r\n\r\nold\r\n\r\n#### Next\r\n';
    const out = replaceSectionBody(md, 'Method', 'new');
    expect(out.ok).toBe(true);
    expect(out.md).toContain('\r\n');
    expect(out.md).toContain('new');
    expect(out.md).not.toContain('old');
  });

  it('ignores ATX headings inside fenced code blocks', () => {
    // A heading-looking line inside a code fence must neither be picked as the
    // section start nor treated as the section boundary.
    const md = [
      '## Real',
      '',
      'before',
      '',
      '```md',
      '## Fake heading in code',
      '```',
      '',
      'after',
      '',
      '## End',
      '',
    ].join('\n');
    const out = replaceSectionBody(md, 'Real', 'NEW');
    expect(out.ok).toBe(true);
    // Body spans past the fenced fake heading, up to the real `## End`.
    expect(out.md).toContain('## Real\n\nNEW\n');
    expect(out.md).toContain('## End');
    // The fenced content is gone (it was inside the replaced body) but was never
    // mistaken for a boundary; the real end heading survived.
    expect(out.md).not.toContain('before');
    expect(out.md).not.toContain('after');
  });

  it('does not select a heading that only appears inside a code fence', () => {
    const md = ['# Doc', '', '```', '## Method', 'x', '```', ''].join('\n');
    const out = replaceSectionBody(md, 'Method', 'NEW');
    expect(out.ok).toBe(false);
    expect(out.md).toBe(md);
  });

  // Fence tracking used to be a boolean toggle that ignored which character
  // opened the block. A ``` nested inside a ~~~ example flipped it, the real
  // closing ~~~ flipped it back, and from there every heading looked fenced —
  // so the body ran to EOF and replacing it deleted the following sections.
  describe('mismatched fence characters', () => {
    it('does not treat ``` inside a ~~~ block as closing it', () => {
      const md = [
        '## Method',
        '',
        'a',
        '~~~',
        '```',
        '~~~',
        'b',
        '',
        '## Results',
        '',
        'keep me',
        '',
      ].join('\n');

      const out = replaceSectionBody(md, 'Method', 'NEW');

      expect(out.ok).toBe(true);
      expect(out.md).toContain('## Results');
      expect(out.md).toContain('keep me');
    });

    it('does not treat ~~~ inside a ``` block as closing it', () => {
      const md = ['## Method', '', '```', '~~~', '```', '', '## Results', '', 'keep me', ''].join(
        '\n'
      );

      const out = replaceSectionBody(md, 'Method', 'NEW');

      expect(out.ok).toBe(true);
      expect(out.md).toContain('## Results');
      expect(out.md).toContain('keep me');
    });

    it('requires the closing run to be at least as long as the opener', () => {
      // ```` opens, so the inner ``` is content and only the final ```` closes.
      const md = [
        '## Method',
        '',
        '````',
        '```',
        'nested',
        '```',
        '````',
        '',
        '## Results',
        '',
        'keep me',
        '',
      ].join('\n');

      const out = replaceSectionBody(md, 'Method', 'NEW');

      expect(out.ok).toBe(true);
      expect(out.md).toContain('## Results');
      expect(out.md).toContain('keep me');
    });

    it('still finds a heading that follows a block with a nested fence', () => {
      const md = ['# Doc', '', '~~~', '```', '~~~', '', '## Method', '', 'body', ''].join('\n');

      const out = replaceSectionBody(md, 'Method', 'NEW');

      expect(out.ok).toBe(true);
      expect(out.md).toContain('## Method\n\nNEW\n');
    });

    it('treats an info string as an opener, not a close', () => {
      // `~~~yaml` opens; the later bare `~~~` closes it.
      const md = ['## Method', '', '~~~yaml', 'a: 1', '~~~', '', '## Results', '', 'keep me', ''].join(
        '\n'
      );

      const out = replaceSectionBody(md, 'Method', 'NEW');

      expect(out.ok).toBe(true);
      expect(out.md).toContain('## Results');
      expect(out.md).toContain('keep me');
    });
  });
});

// #51: the same heading text under different unit operations.
describe('findSectionMatches / replaceSectionBodyAt', () => {
  const repeated = [
    '## Unit Operations',
    '',
    '### [USW230 Embed]',
    '',
    '#### Method',
    '',
    'a',
    '',
    '```md',
    '#### Method',
    '```',
    '',
    '### [UHW100 PCR] alias',
    '',
    '#### Method',
    '',
    'b',
    '',
  ].join('\n');

  it('lists every match outside code fences with its enclosing heading', () => {
    expect(findSectionMatches(repeated, 'Method')).toEqual([
      { line: 4, level: 4, parentHeading: '[USW230 Embed]', occurrence: 1 },
      { line: 14, level: 4, parentHeading: '[UHW100 PCR] alias', occurrence: 2 },
    ]);
    expect(findSectionMatches(repeated, 'Unit Operations')).toEqual([
      { line: 0, level: 2, parentHeading: '', occurrence: 1 },
    ]);
  });

  it('replaces the section at a given heading line only', () => {
    const out = replaceSectionBodyAt(repeated, 14, 'NEW');
    expect(out.ok).toBe(true);
    expect(out.md).toContain('a\n');
    expect(out.md).not.toContain('\nb\n');
    expect(out.md.endsWith('#### Method\n\nNEW\n')).toBe(true);
  });

  it('refuses a line that is not a heading', () => {
    expect(replaceSectionBodyAt(repeated, 6, 'x')).toEqual({ ok: false, md: repeated });
  });

  it('keeps replaceSectionBody on the first match', () => {
    const out = replaceSectionBody(repeated, 'Method', 'FIRST');
    expect(out.md).toContain('FIRST');
    expect(out.md).toContain('\nb\n');
  });
});

describe('heading fallback (#145) and repeated heading (#162)', () => {
  it('normalizes emoji, variation selectors, brackets, case and spaces', () => {
    expect(normalizeHeadingText('🧪 Related  Workflows')).toBe('related workflows');
    expect(normalizeHeadingText('⚠️ [Notes]')).toBe('notes');
  });

  it('prefers exact matches and falls back only when there are none', () => {
    const md = '## Results\n\na\n\n## ✅ results\n\nb\n';
    expect(findSectionMatches(md, 'Results').map(m => m.line)).toEqual([0]);
    expect(findSectionMatches(md, 'RESULTS').map(m => m.line)).toEqual([0, 4]);
    expect(findSectionMatches(md, 'Nothing')).toEqual([]);
  });

  it('drops a leading heading equal to the target and the blank lines after it', () => {
    expect(stripRepeatedHeading('\n### 🧪 Results\n\nbody\n', 'Results')).toBe('body\n');
    expect(stripRepeatedHeading('### Other\n\nbody', 'Results')).toBe('### Other\n\nbody');
    expect(stripRepeatedHeading('body', 'Results')).toBe('body');
  });
});
