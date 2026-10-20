/**
 * #105: an experiment README's `sample_tracking: 'no'` turns highlighting off
 * for that experiment's notes, so an open editor must redraw when the README
 * changes even though its own text and viewport did not.
 */
import { describe, it, expect } from 'vitest';
import {
  collectTokenRanges,
  highlightStateKey,
  missingSampleCheck,
  needsHighlightRebuild,
} from '../../src/sampleHighlight';
import { findDefinedSampleIds } from '../../packages/labnoteo-core/src/lib/sampleStorage';

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
