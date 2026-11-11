// The line each fence reader steps on: a fence in a list item or a block quote read as CommonMark
// has it (see containerFences.test.ts for the readers).
import { describe, it, expect } from 'vitest';
import { fenceView } from '../sections/codeFences';

const t = '```';

describe('the fence view of a line in a container', () => {
  it('takes off the list marker and the item indent', () => {
    expect(fenceView([`- ${t}md`, '  x', `  ${t}`, 'y'])).toEqual([`${t}md`, 'x', t, 'y']);
  });

  it('takes off the quote markers', () => {
    expect(fenceView([`> ${t}`, '> x', `> ${t}`])).toEqual([t, 'x', t]);
  });

  it('closes a fence its list item ends: the line before reads as the closer', () => {
    expect(fenceView([`- ${t}`, '  x', 'y'])).toEqual([t, t, 'y']);
  });

  it('closes a fence its quote ends', () => {
    expect(fenceView([`> ${t}`, '> x', '', t])).toEqual([t, t, '', t]);
  });

  it('reads an opener its item ends at once as text', () => {
    expect(fenceView([`- ${t}`, 'y'])).toEqual(['', 'y']);
  });

  it('keeps a lazy paragraph line in its item', () => {
    expect(fenceView(['- a', 'b', `  ${t}`, '  x', `  ${t}`])).toEqual(['a', 'b', t, 'x', t]);
  });

  it('ends the item at an HTML block start, which a lazy line cannot be', () => {
    expect(fenceView(['- a', '<div>', '', `  ${t}`, 'x'])).toEqual(['a', '', '', `  ${t}`, 'x']);
  });

  it('reads the lines of an HTML block as empty, a backtick run there too', () => {
    expect(fenceView(['<!--', t, '-->', `- ${t}md`, `  ${t}`])).toEqual(['', '', '', `${t}md`, t]);
  });

  it('reads a type 7 tag after an item fence its next item ended as an HTML block', () => {
    expect(fenceView([`- ${t}md`, '- [ ] a', `  ${t}`, '</span>', t, '', 'x'])).toEqual(['', '[ ] a', '', '', '', '', 'x']);
  });

  it('reads a line in no container as it is', () => {
    expect(fenceView([t, '  x', `   ${t}`])).toEqual([t, '  x', `   ${t}`]);
  });

});
