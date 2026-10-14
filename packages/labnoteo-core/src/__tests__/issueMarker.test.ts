/**
 * Markers are the only thing that turns a line of a note into a GitHub Issue,
 * and three components parse them independently of each other (insert command,
 * `issue-sync`, `validate`). A grammar bug here is invisible in Obsidian and
 * surfaces only as a discussion that never reached the team, so the boundary
 * cases are pinned exhaustively.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ISSUE_MARKER_ID_PREFIX,
  findEnclosingHeading,
  findIssueMarkerRanges,
  generateIssueMarkerId,
  parseIssueMarkers,
  planIssueMarkerInsertion,
  reassignIssueMarkerIds,
  renderIssueMarker,
  resetIssueMarkerIdCounter,
} from '../lib/issueMarker';

// #89: a copied note must not share issue IDs with the original.
describe('reassignIssueMarkerIds', () => {
  const ids = () => {
    let n = 0;
    return () => `ISS-new${++n}`;
  };

  it('replaces each marker ID and keeps delimiter, topic and the text around it', () => {
    const md = '결과 @issue;ISS-a;수율 차이\n@issue:ISS-b:시드 배양\n@issue;ISS-c;\n본문';
    expect(reassignIssueMarkerIds(md, ids())).toEqual({
      content: '결과 @issue;ISS-new1;수율 차이\n@issue:ISS-new2:시드 배양\n@issue;ISS-new3;\n본문',
      count: 3,
    });
  });

  it('skips fenced examples, as issue-sync does', () => {
    const md = '```\n@issue;ISS-a;예시\n```\n@issue;ISS-b;진짜';
    const out = reassignIssueMarkerIds(md, ids());
    expect(out.content).toBe('```\n@issue;ISS-a;예시\n```\n@issue;ISS-new1;진짜');
    expect(parseIssueMarkers(out.content).markers.map(m => m.id)).toEqual(['ISS-new1']);
  });

  it('keeps CRLF line endings', () => {
    expect(reassignIssueMarkerIds('a @issue;ISS-a;x\r\nb\r\n', ids()).content).toBe('a @issue;ISS-new1;x\r\nb\r\n');
  });

  it('reports zero for a note without markers', () => {
    expect(reassignIssueMarkerIds('@issue 문법 설명', ids())).toEqual({ content: '@issue 문법 설명', count: 0 });
  });

  it('generates distinct IDs by default', () => {
    const { content } = reassignIssueMarkerIds('@issue;ISS-a;x\n@issue;ISS-a;y');
    const [first, second] = parseIssueMarkers(content).markers.map(m => m.id);
    expect(first).not.toBe('ISS-a');
    expect(first).not.toBe(second);
  });
});

describe('parseIssueMarkers', () => {
  it('reads a marker that follows prose on the same line', () => {
    const md = '3차 시도에서만 수율 40%. @issue;ISS-mkd8x3k;시드 배양 시간 차이 때문인지 논의 필요';
    expect(parseIssueMarkers(md).markers).toEqual([
      { id: 'ISS-mkd8x3k', title: '시드 배양 시간 차이 때문인지 논의 필요', line: 1 },
    ]);
  });

  it('takes the rest of the line as the title, including punctuation', () => {
    const { markers } = parseIssueMarkers('@issue;ISS-a1;A/B 중 무엇? 결정 필요; 내일까지');
    expect(markers[0].title).toBe('A/B 중 무엇? 결정 필요; 내일까지');
  });

  it('accepts `:` as a delimiter, like sample references do', () => {
    const { markers } = parseIssueMarkers('@issue:ISS-a1:재현 조건 확인');
    expect(markers[0]).toMatchObject({ id: 'ISS-a1', title: '재현 조건 확인' });
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseIssueMarkers('@Issue;ISS-a1;확인').markers).toHaveLength(1);
  });

  it('reports 1-based line numbers for several markers', () => {
    const md = ['# Results', '@issue;ISS-a;첫째', 'prose', '@issue;ISS-b;둘째'].join('\n');
    expect(parseIssueMarkers(md).markers.map(m => m.line)).toEqual([2, 4]);
  });

  it('ignores markers inside fenced code so a note may document the syntax', () => {
    const md = ['```markdown', '@issue;ISS-example;예시', '```', '@issue;ISS-real;진짜'].join('\n');
    const { markers } = parseIssueMarkers(md);
    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe('ISS-real');
  });

  it('handles tilde fences and unclosed fences', () => {
    expect(parseIssueMarkers('~~~\n@issue;ISS-a;x\n~~~').markers).toHaveLength(0);
    expect(parseIssueMarkers('```\n@issue;ISS-a;x').markers).toHaveLength(0);
  });

  it('does not match a word that merely starts with the keyword', () => {
    const scan = parseIssueMarkers('@issues;ISS-a;x 그리고 issue 이야기');
    expect(scan.markers).toHaveLength(0);
    expect(scan.malformed).toHaveLength(0);
  });

  it('reports a topic sentence written without an ID', () => {
    const scan = parseIssueMarkers('@issue;수율이 재현되지 않음');
    expect(scan.markers).toHaveLength(0);
    expect(scan.malformed).toEqual([
      { line: 1, text: '@issue;수율이 재현되지 않음', reason: 'missing-id' },
    ]);
  });

  it('reports an ID with no topic sentence', () => {
    expect(parseIssueMarkers('@issue;ISS-a1;').malformed[0].reason).toBe('missing-title');
    expect(parseIssueMarkers('@issue;ISS-a1;   ').malformed[0].reason).toBe('missing-title');
    expect(parseIssueMarkers('@issue;ISS-a1').malformed[0].reason).toBe('missing-title');
  });

  // A delimiter after the keyword is what makes a line a marker candidate.
  // Without that rule the keyword alone counted as a malformed marker, and
  // since `validate` fails the push on malformed markers, writing about the
  // feature in a note was enough to turn CI red. `AGENTS.md` documents the
  // syntax, so researchers do write the word.
  describe('the keyword in prose', () => {
    it('ignores a bare keyword used as a word', () => {
      const scan = parseIssueMarkers('다음 단계는 @issue 마커 문법을 참고하세요.');
      expect(scan.markers).toEqual([]);
      expect(scan.malformed).toEqual([]);
    });

    it('ignores a keyword at end of line', () => {
      expect(parseIssueMarkers('@issue')).toEqual({ markers: [], malformed: [] });
    });

    it('still reports a delimited marker whose ID is missing', () => {
      // The delimiter shows intent, so this stays a typo worth failing on.
      expect(parseIssueMarkers('@issue;수율이 재현되지 않음').malformed[0].reason).toBe(
        'missing-id'
      );
    });

    it('finds a real marker later on a line that mentions the keyword first', () => {
      const { markers } = parseIssueMarkers('@issue 문법 참고. @issue;ISS-a1;진짜 논의');
      expect(markers).toEqual([{ id: 'ISS-a1', title: '진짜 논의', line: 1 }]);
    });
  });

  it('returns nothing for a note with no markers', () => {
    expect(parseIssueMarkers('# Results\n수율 40%')).toEqual({ markers: [], malformed: [] });
  });
});

describe('findIssueMarkerRanges', () => {
  it('spans from the keyword to end of line, leaving the prose before it alone', () => {
    const text = '수율 40%. @issue;ISS-a1;논의 필요';
    expect(findIssueMarkerRanges(text)).toEqual([
      { start: text.indexOf('@issue'), end: text.length },
    ]);
  });

  it('stops at the newline, not at the end of the document', () => {
    const text = '@issue;ISS-a1;첫째\n다음 줄';
    expect(findIssueMarkerRanges(text)[0]).toEqual({ start: 0, end: '@issue;ISS-a1;첫째'.length });
  });

  it('offsets correctly across several lines', () => {
    const text = 'a\nb\n@issue;ISS-a1;x';
    expect(findIssueMarkerRanges(text)).toEqual([{ start: 4, end: text.length }]);
  });

  // The highlight is the feedback: an unstyled marker is one that opens nothing.
  it('ignores malformed markers so styling signals validity', () => {
    expect(findIssueMarkerRanges('@issue;주제만 있고 ID 없음')).toEqual([]);
    expect(findIssueMarkerRanges('@issue;ISS-a1;')).toEqual([]);
  });
});

describe('generateIssueMarkerId', () => {
  beforeEach(() => resetIssueMarkerIdCounter());

  it('is prefixed and base36 — shorter than the decimal sample IDs', () => {
    const id = generateIssueMarkerId();
    expect(id.startsWith(`${ISSUE_MARKER_ID_PREFIX}-`)).toBe(true);
    expect(id).toMatch(/^ISS-[0-9a-z]+$/);
    expect(id.length).toBeLessThan(`DNA-${Date.now()}`.length);
  });

  it('never repeats within a burst', () => {
    const ids = Array.from({ length: 50 }, () => generateIssueMarkerId());
    expect(new Set(ids).size).toBe(50);
  });

  it('round-trips through the parser', () => {
    const id = generateIssueMarkerId();
    const { markers } = parseIssueMarkers(renderIssueMarker({ id, title: '확인 필요' }));
    expect(markers[0]).toMatchObject({ id, title: '확인 필요' });
  });
});

describe('planIssueMarkerInsertion', () => {
  const ID = 'ISS-t';

  /** Run the plan for `[from, to)` and apply it; throws when it was refused. */
  function insert(doc: string, from: number, to = from): { out: string; cursor: number } {
    const plan = planIssueMarkerInsertion(doc, from, to, ID);
    if ('reason' in plan) throw new Error(`refused: ${plan.reason}`);
    const { edit, cursor } = plan;
    return { out: doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to), cursor };
  }
  /** Select the first occurrence of `text`. */
  const select = (doc: string, text: string): [number, number] => {
    const at = doc.indexOf(text);
    return [at, at + text.length];
  };
  const titleOf = (md: string): string | undefined => parseIssueMarkers(md).markers[0]?.title;

  it('keeps the sentence and appends the marker when text follows the selection (#28)', () => {
    const doc = 'BS-3 형광 높음 누출 의심';
    const { out, cursor } = insert(doc, ...select(doc, 'BS-3 형광 '));
    expect(out).toBe('BS-3 형광 높음 누출 의심 @issue;ISS-t;BS-3 형광');
    expect(cursor).toBe(out.length);
    expect(titleOf(out)).toBe('BS-3 형광');
  });

  it('leaves a metadata line intact', () => {
    const doc = '- Equipment: Multi-functional microplate reader';
    const { out } = insert(doc, ...select(doc, 'Equipment: Multi-functional '));
    expect(out).toBe(`${doc} @issue;ISS-t;Equipment: Multi-functional`);
    expect(titleOf(out)).toBe('Equipment: Multi-functional');
  });

  it('moves a bare caret in mid-line to the line end instead of splitting a word', () => {
    const doc = '0 µM에서도 높음. 누출 의심\n다음 줄';
    const { out, cursor } = insert(doc, doc.indexOf('도 높음'));
    expect(out).toBe('0 µM에서도 높음. 누출 의심 @issue;ISS-t;\n다음 줄');
    expect(out.slice(0, cursor)).toBe('0 µM에서도 높음. 누출 의심 @issue;ISS-t;');
  });

  it('inserts at a caret on the line end, spaced from the text before it', () => {
    expect(insert('수율 40%.', 7).out).toBe('수율 40%. @issue;ISS-t;');
    expect(insert('수율 40% ', 7).out).toBe('수율 40% @issue;ISS-t;');
    expect(insert('', 0).out).toBe('@issue;ISS-t;');
  });

  it('replaces a selection that runs to the line end, keeping the space before it', () => {
    const doc = '결과: BS-3 형광';
    const { out } = insert(doc, ...select(doc, ' BS-3 형광'));
    expect(out).toBe('결과: @issue;ISS-t;BS-3 형광');
    expect(titleOf(out)).toBe('BS-3 형광');
  });

  it('treats a selection that took its line break as ending on that line', () => {
    const doc = '누출 의심\n다음 줄';
    const { out } = insert(doc, ...select(doc, '누출 의심\n'));
    expect(out).toBe('@issue;ISS-t;누출 의심\n다음 줄');
  });

  it('joins a multi-line selection into one topic', () => {
    const doc = 'line one\nline two tail';
    const { out } = insert(doc, doc.indexOf('one'), doc.indexOf(' tail'));
    expect(out).toBe('line one\nline two tail @issue;ISS-t;one line two');
    expect(titleOf(out)).toBe('one line two');

    const toEnd = 'a first\nsecond';
    expect(insert(toEnd, ...select(toEnd, 'first\nsecond')).out).toBe('a @issue;ISS-t;first second');
  });

  it('accepts a backwards selection', () => {
    const doc = 'BS-3 형광 높음';
    const [from, to] = select(doc, 'BS-3');
    expect(insert(doc, to, from).out).toBe('BS-3 형광 높음 @issue;ISS-t;BS-3');
  });

  it('puts the marker under a heading instead of into it', () => {
    const doc = '### [UHW010 A]\n\n#### Meta';
    expect(insert(doc, 6).out).toBe('### [UHW010 A]\n@issue;ISS-t;\n\n#### Meta');
    const { out } = insert(doc, ...select(doc, 'UHW010 A'));
    expect(out).toBe('### [UHW010 A]\n@issue;ISS-t;UHW010 A\n\n#### Meta');
    expect(parseIssueMarkers(out).markers[0]).toMatchObject({ title: 'UHW010 A', line: 2 });
  });

  it('refuses inside a table row', () => {
    expect(planIssueMarkerInsertion('| a | b |', 2, 3, ID)).toEqual({ reason: 'table' });
  });

  it('refuses a second marker on one line', () => {
    const doc = 'foo @issue;ISS-a;기존 논의';
    expect(planIssueMarkerInsertion(doc, 0, 0, ID)).toEqual({ reason: 'conflict' });
    expect(planIssueMarkerInsertion(doc, 0, 3, ID)).toEqual({ reason: 'conflict' });
    expect(planIssueMarkerInsertion(doc, doc.length, doc.length, ID)).toEqual({ reason: 'conflict' });
    // A selection that contains a marker would put it into the new topic.
    expect(planIssueMarkerInsertion(doc, 0, doc.length, ID)).toEqual({ reason: 'conflict' });
  });

  // #87: a marker in the front matter breaks the YAML and never opens an issue.
  it('refuses in the front matter, its --- lines included', () => {
    const doc = '---\ntitle: 시험\nstatus: planned\n---\n\n본문 문장\n# 제목\n';
    for (const text of ['---', 'title: 시험', 'status: planned\n---']) {
      expect(planIssueMarkerInsertion(doc, ...select(doc, text), ID)).toEqual({ reason: 'frontMatter' });
    }
    expect(planIssueMarkerInsertion(doc, doc.indexOf('\n---') + 1, doc.indexOf('\n---') + 1, ID)).toEqual({
      reason: 'frontMatter',
    });
    // A selection running from the front matter into the body is refused too.
    expect(planIssueMarkerInsertion(doc, doc.indexOf('status'), doc.indexOf(' 문장'), ID)).toEqual({
      reason: 'frontMatter',
    });
  });

  it('still inserts in the body above the title', () => {
    const doc = '---\ntitle: 시험\n---\n본문 문장\n# 제목\n';
    expect(insert(doc, ...select(doc, '본문 문장')).out).toBe(
      '---\ntitle: 시험\n---\n@issue;ISS-t;본문 문장\n# 제목\n'
    );
  });
});

describe('findEnclosingHeading', () => {
  const md = [
    '# Objective', // 1
    'text', // 2
    '## Results', // 3
    '@issue;ISS-a;x', // 4
    '```', // 5
    '# NotAHeading', // 6
    '```', // 7
    '@issue;ISS-b;y', // 8
  ].join('\n');

  it('finds the nearest heading above the line', () => {
    expect(findEnclosingHeading(md, 4)).toBe('Results');
  });

  it('skips headings that are inside fenced code', () => {
    expect(findEnclosingHeading(md, 8)).toBe('Results');
  });

  it('returns the heading itself when the line is the heading', () => {
    expect(findEnclosingHeading(md, 3)).toBe('Results');
  });

  it('is undefined before any heading', () => {
    expect(findEnclosingHeading('prose\n@issue;ISS-a;x', 2)).toBeUndefined();
  });
});
