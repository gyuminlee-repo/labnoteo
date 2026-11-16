/**
 * The Meta-property guard (4519dd7) reads a note as the one block reading does: a `key: value`
 * line inside a fence, an indented code block or an HTML block under `#### Meta` is no
 * property, so a date or an issue marker is not refused there as if it were one.
 */
import { describe, it, expect } from 'vitest';
import { overlapsMetaProperty } from '../sections/metaContext';
import { planDateInsertion } from '../sections/frontMatter';
import { planIssueMarkerInsertion } from '../lib/issueMarker';

const META = '### [UHW010 Spin] one\n#### Meta\n- Start_date: today\n';
const REST = '#### Input\n- sample\n#### Method\nspin\n';

describe.each(['\n', '\r\n'])('a key: line under Meta (newline %j)', nl => {
  const at = (doc: string, needle: string) => [doc.indexOf(needle), doc.indexOf(needle) + needle.length] as const;
  const note = (block: string) => `${META}${block}${REST}`.replace(/\n/g, nl);

  it('is a property on a text line', () => {
    const doc = note('- End_date: later\n');
    expect(overlapsMetaProperty(doc, ...at(doc, 'End_date: later'))).toBe(true);
    expect(planDateInsertion(doc, ...at(doc, 'End_date: later'), '2026-11-13')).toEqual({ reason: 'metaDate' });
  });

  it.each([
    ['a fence', '```yaml\nkey: value\n```\n'],
    ['a tilde fence', '~~~\nkey: value\n~~~\n'],
    ['an HTML block', '<div>\nkey: value\n</div>\n'],
  ])('is no property inside %s', (_name, block) => {
    const doc = note(block);
    const [from, to] = at(doc, 'key: value');
    expect(overlapsMetaProperty(doc, from, to)).toBe(false);
    expect(planDateInsertion(doc, from, to, '2026-11-13')).not.toHaveProperty('reason');
    expect(planIssueMarkerInsertion(doc, from, to, 'ISS-test', 'topic')).not.toEqual({ reason: 'meta' });
  });
});
