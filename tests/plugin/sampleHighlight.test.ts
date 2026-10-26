/**
 * #105: an experiment README's `sample_tracking: 'no'` turns highlighting off
 * for that experiment's notes, so an open editor must redraw when the README
 * changes even though its own text and viewport did not.
 */
import { describe, it, expect } from 'vitest';
import {
  collectTokenRanges,
  discardedSampleCheck,
  highlightStateKey,
  missingSampleCheck,
  needsHighlightRebuild,
  staleAliasCheck,
} from '../../src/sampleHighlight';
import { findDefinedSampleIds } from '../../packages/labnoteo-core/src/lib/sampleStorage';
import { commentRanges } from '../../packages/labnoteo-core/src/lib/issueMarker';

const on = { types: ['RNA', 'Cell'], colors: { RNA: 'red', Cell: 'blue' } };
const off = { types: [], colors: {} };
const still = { docChanged: false, viewportChanged: false };

describe('needsHighlightRebuild', () => {
  it('redraws when tracking turns off or on with no edit', () => {
    expect(needsHighlightRebuild(still, highlightStateKey(on), highlightStateKey(off))).toBe(true);
    expect(needsHighlightRebuild(still, highlightStateKey(off), highlightStateKey(on))).toBe(true);
  });

  it('leaves the decorations alone when nothing changed', () => {
    expect(needsHighlightRebuild(still, highlightStateKey(on), highlightStateKey({ ...on }))).toBe(false);
  });

  it('redraws on an edit or a scroll as before', () => {
    const key = highlightStateKey(on);
    expect(needsHighlightRebuild({ docChanged: true, viewportChanged: false }, key, key)).toBe(true);
    expect(needsHighlightRebuild({ docChanged: false, viewportChanged: true }, key, key)).toBe(true);
  });

  it('tells a colour change apart', () => {
    expect(highlightStateKey(on)).not.toBe(highlightStateKey({ ...on, colors: { RNA: 'green', Cell: 'blue' } }));
  });
});

// #428: a marker in a note the automation does not read stays plain.
describe('markers of a note that is not read for markers', () => {
  it('draws the samples but not the marker', () => {
    const text = '@issue;ISS-1;RNA-1 확인';
    expect(collectTokenRanges(text, on.types, on.colors).map(r => r.cls)).toEqual(['labnote-issue-marker']);
    expect(collectTokenRanges(text, on.types, on.colors, { noMarkers: true }).map(r => r.cls)).toEqual([
      'labnote-sample-id',
    ]);
    expect(highlightStateKey({ ...on, markersUnread: true })).not.toBe(highlightStateKey(on));
  });
});

// #210: a sample ID the note cannot resolve is underlined with a tooltip.
describe('sample IDs missing from the registry', () => {
  const types = ['DNA', 'RNA'];
  const colors = { DNA: 'red', RNA: 'blue' };
  const TITLE = 'Not in the sample registry';
  const marked = (text: string, knownIds?: string[]) => {
    const state = { types, colors, knownIds: knownIds && new Set(knownIds), missingTitle: TITLE };
    const missing = missingSampleCheck(state, findDefinedSampleIds(text, types));
    return collectTokenRanges(text, types, colors, { missing })
      .filter(r => r.cls.includes('labnote-sample-id-missing'))
      .map(r => ({ id: text.slice(r.start, r.end), title: r.title }));
  };

  it('marks nothing before the registries are read', () => {
    expect(marked('DNA-1 RNA-2')).toEqual([]);
  });

  it('marks only the IDs the registries do not have, ignoring case', () => {
    expect(marked('DNA-1 DNA-55 RNA-2', ['dna-1', 'dna-55'])).toEqual([{ id: 'RNA-2', title: TITLE }]);
  });

  it('counts the IDs the note itself defines, with @type; or @type:', () => {
    expect(marked('@dna;DNA-7;new\nDNA-7 again\n@rna:RNA-8\nDNA-9', [])).toEqual([{ id: 'DNA-9', title: TITLE }]);
  });

  it('leaves a sample ID inside an issue marker alone', () => {
    expect(marked('@issue;ISS-a1b2;DNA-3 왜 안 될까', [])).toEqual([]);
  });

  it('redraws when the registries were read again', () => {
    expect(highlightStateKey({ ...on, sampleVersion: 1 })).not.toBe(highlightStateKey({ ...on, sampleVersion: 2 }));
  });
});

// #239: a reference whose alias was edited in the note no longer matches the registry.
describe('sample references with another alias than the registry', () => {
  const types = ['Strain', 'DNA'];
  const colors = { Strain: 'red', DNA: 'blue' };
  const ID = 'Strain-1792600000001';
  const aliases = new Map([
    [ID.toLowerCase(), 'COL-001'],
    ['dna-2', ''],
  ]);
  const ranges = (text: string) => {
    const state = {
      types,
      colors,
      knownIds: new Set(aliases.keys()),
      knownAliases: aliases,
      staleAliasTitle: (a: string) => `registry: ${a}`,
    };
    const staleAlias = staleAliasCheck(state, findDefinedSampleIds(text, types));
    return collectTokenRanges(text, types, colors, { staleAlias }).map(r => ({
      text: text.slice(r.start, r.end),
      stale: r.cls.includes('labnote-sample-alias-stale'),
      title: r.title,
    }));
  };

  it('marks the ID and the alias written in the note, naming the registry alias', () => {
    expect(ranges(`PI 검토: 사용한 집락 ${ID};COL-001b 확인`)).toEqual([
      { text: `${ID};COL-001b`, stale: true, title: 'registry: COL-001' },
    ]);
    expect(ranges(`재확인한 집락: ${ID};집락B`)[0]).toMatchObject({ text: `${ID};집락B`, stale: true });
  });

  it('leaves a matching alias, a bare ID and a sample without an alias alone', () => {
    expect(ranges(`${ID};COL-001 was picked, ${ID}. | ${ID};COL-001 |`).every(r => !r.stale)).toBe(true);
    expect(ranges('DNA-2;pUC19').every(r => !r.stale)).toBe(true);
  });

  it('leaves a sample the note defines, whose alias the sync writes to the registry', () => {
    expect(ranges(`@strain;${ID};COL-002\n${ID};COL-002`).every(r => !r.stale)).toBe(true);
  });

  it('keeps the marks apart when the alias runs into another ID', () => {
    expect(ranges(`${ID};DNA-2`)).toEqual([{ text: `${ID};DNA-2`, stale: true, title: 'registry: COL-001' }]);
  });
});

// #329: reading view ends the text before the link an older alias holds.
describe('a registry alias the reading view cut short', () => {
  const types = ['Reagent'];
  const colors = { Reagent: 'red' };
  const ID = 'Reagent-1792868825877';
  const state = {
    types,
    colors,
    knownIds: new Set([ID.toLowerCase()]),
    knownAliases: new Map([[ID.toLowerCase(), '표준 [트롤록스](1mM)']]),
    staleAliasTitle: (a: string) => `registry: ${a}`,
  };
  const staleAlias = staleAliasCheck(state, new Set());

  it('takes the start of the registry alias for the alias when the text was cut', () => {
    const text = `- ${ID};표준 `;
    expect(collectTokenRanges(text, types, colors, { staleAlias, cut: true })[0].cls).toBe('labnote-sample-id');
    expect(collectTokenRanges(text, types, colors, { staleAlias })[0].cls).toContain('labnote-sample-alias-stale');
  });
});

// #330: a reference to a discarded sample looked like any other.
describe('references to a discarded sample', () => {
  const types = ['Other'];
  const colors = { Other: 'red' };
  const state = {
    types,
    colors,
    knownIds: new Set(['other-1', 'other-2']),
    knownAliases: new Map([
      ['other-1', 'SUP-08'],
      ['other-2', ''],
    ]),
    staleAliasTitle: (a: string) => `registry: ${a}`,
    discardedIds: new Map([['other-1', '2026-10-25']]),
    discardedTitle: (d: string) => `discarded: ${d}`,
  };
  const ranges = (text: string) =>
    collectTokenRanges(text, types, colors, {
      staleAlias: staleAliasCheck(state, new Set()),
      discarded: discardedSampleCheck(state),
    }).map(r => ({ text: text.slice(r.start, r.end), cls: r.cls, title: r.title }));

  it('fades the discarded one with its date, also next to a stale alias', () => {
    expect(ranges('Other-1;SUP-08 Other-2')).toEqual([
      { text: 'Other-1', cls: 'labnote-sample-id labnote-sample-discarded', title: 'discarded: 2026-10-25' },
      { text: 'Other-2', cls: 'labnote-sample-id', title: undefined },
    ]);
    expect(ranges('Other-1;SUP-09')[0]).toEqual({
      text: 'Other-1;SUP-09',
      cls: 'labnote-sample-id labnote-sample-alias-stale labnote-sample-discarded',
      title: 'discarded: 2026-10-25\nregistry: SUP-08',
    });
  });
});

// #266: a marker in a comment is hidden in the reading view and read by nothing.
describe('issue markers in comments', () => {
  const markers = (text: string) => {
    const comments = commentRanges(text);
    const inComment = (at: number): boolean => comments.some(c => at >= c.start && at < c.end);
    return collectTokenRanges(text, [], {}, { inComment })
      .filter(r => r.cls.includes('labnote-issue-marker'))
      .map(r => text.slice(r.start, r.end));
  };

  it('styles neither a one-line nor a multi-line comment, and never the closing -->', () => {
    const text = [
      '<!-- 이슈 끔: @issue;ISS-oldnote1;형광 판독 기준 재검토 -->',
      '',
      '<!--',
      '@issue;ISS-oldnote2;여러 줄 주석 안',
      '-->',
    ].join('\n');
    expect(markers(text)).toEqual([]);
  });

  it('styles a live marker after a comment on the same line', () => {
    expect(markers('%% 메모 %% @issue;ISS-a;진짜 논의')).toEqual(['@issue;ISS-a;진짜 논의']);
  });

  it('still styles sample IDs in a comment', () => {
    const text = '<!-- DNA-1 -->';
    const comments = commentRanges(text);
    const inComment = (at: number): boolean => comments.some(c => at >= c.start && at < c.end);
    expect(collectTokenRanges(text, ['DNA'], {}, { inComment }).map(r => text.slice(r.start, r.end))).toEqual([
      'DNA-1',
    ]);
  });
});
