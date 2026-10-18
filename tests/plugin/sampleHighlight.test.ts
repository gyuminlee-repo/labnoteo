/**
 * #105: an experiment README's `sample_tracking: 'no'` turns highlighting off
 * for that experiment's notes, so an open editor must redraw when the README
 * changes even though its own text and viewport did not.
 */
import { describe, it, expect } from 'vitest';
import { highlightStateKey, needsHighlightRebuild } from '../../src/sampleHighlight';

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
