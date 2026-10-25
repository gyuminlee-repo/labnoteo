/**
 * #257: "AI: Summarize results" on a note holding only the template answered
 * with measurements nobody had written down.
 */
import { describe, it, expect } from 'vitest';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown, buildSwUnitOpMarkdown } from '../lib/unitOpTemplate';
import {
  dropEchoedLines,
  extractResultSections,
  shareBudget,
  hasRecordedResults,
  maskAiCallouts,
  stripAiCallouts,
  stripTemplatePlaceholders,
} from '../lib/noteResults';

const META = { experimenter: 'Dr. Kim', dateTime: '2026-10-15 10:00' };

/** A workflow note with one lab unit operation, as the commands write it. */
const note = (edit: (md: string) => string = md => md): string =>
  edit(
    createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim') +
      buildHwUnitOpMarkdown({ opId: 'UHW010', opName: 'Spin', opDescription: 'step' }, META)
  );

describe('hasRecordedResults', () => {
  it('says no for a note that is nothing but the template', () => {
    expect(hasRecordedResults(note())).toBe(false);
  });

  it('says no when only a non-result section was filled in', () => {
    const md = note(m => m.replace('- (samples from the previous step)', '- DNA-1 plasmid'));
    expect(hasRecordedResults(md)).toBe(false);
  });

  it('says yes once Results & Discussions holds something', () => {
    const md = note(m => m.replace('- (Any results and discussions. Link file path if needed)', '- 수율 12 ng/µL'));
    expect(hasRecordedResults(md)).toBe(true);
  });

  it('says yes for a software unit operation with QC Metrics or Discussion written in', () => {
    const sw = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim') +
      buildSwUnitOpMarkdown({ opId: 'USW010', opName: 'Align', opDescription: 'step' }, META);
    expect(hasRecordedResults(sw)).toBe(false);
    expect(hasRecordedResults(sw.replace('- (performance metrics, QC indicators)', '- F1 0.92'))).toBe(true);
    expect(hasRecordedResults(sw.replace('- (comments for the next step)', '- 다음엔 샘플을 늘린다'))).toBe(true);
  });

  it("says yes for the note's own Conclusions and Discussion", () => {
    const md = note().replace('## Conclusions and Discussion\n', '## Conclusions and Discussion\n\n전환 효율이 낮았다\n');
    expect(hasRecordedResults(md)).toBe(true);
  });

  // The researcher's own section is not the template's to judge.
  it('says yes for a heading the researcher added', () => {
    expect(hasRecordedResults(`${note()}\n## 결과\n\n콜로니 24개\n`)).toBe(true);
  });

  it('leaves a note that does not follow the template alone', () => {
    expect(hasRecordedResults('# Shopping\n\n- milk\n')).toBe(true);
  });

  // #150: a summary inserted earlier must not pass as a result of its own.
  it('does not count an AI summary callout already in the note', () => {
    const md = `${note()}\n> [!note] AI summary (llama3.1, 2026-10-15)\n> - 수율이 높았다\n>\n> - 재현성 좋음\n`;
    expect(hasRecordedResults(md)).toBe(false);
    expect(hasRecordedResults(`${md}\n## 결과\n\n콜로니 24개\n`)).toBe(true);
  });
});

describe('stripAiCallouts', () => {
  it('drops the callout and keeps the rest', () => {
    const md = ['before', '> [!note] AI 요약 (llama3.1)', '> - 한 줄', '>', '> - 두 줄', '', 'after'].join('\n');
    expect(stripAiCallouts(md).split('\n').filter(l => l.trim())).toEqual(['before', 'after']);
  });

  it('keeps a quote that is not an AI answer', () => {
    expect(stripAiCallouts('> [!warning] 주의\n> 조심')).toContain('조심');
  });
});

describe('stripTemplatePlaceholders', () => {
  it('drops the template wording the model would otherwise read as content', () => {
    const out = stripTemplatePlaceholders(note(m => m.replace('- (samples from the previous step)', '- DNA-1')));
    expect(out).toContain('- DNA-1');
    expect(out).not.toContain('(Any results and discussions');
    expect(out).not.toContain('(e.g. enzyme, buffer, etc.)');
  });
});

// #279: the summary sent the whole note, reagent lists and front matter included.
describe('extractResultSections', () => {
  it('keeps the result sections, each under its unit operation', () => {
    const md = [
      '---',
      'title: WD010 A',
      '---',
      '## [WD010 A]',
      '> desc',
      '### [UHW010 Spin] 조건 A',
      '#### Reagent',
      '- Tris',
      '#### Results & Discussions',
      '- (Any results and discussions. Link file path if needed)',
      '수율 82%',
      '---',
      '### [UHW020 Mix]',
      '#### Results & Discussions',
      '- (Any results and discussions. Link file path if needed)',
      '## Conclusions and Discussion',
      '> [!note] AI summary (m, 2026-01-01)',
      '> - 옛 요약',
      '결론 메모',
    ].join('\n');
    expect(extractResultSections(md)).toBe(
      '### [UHW010 Spin] 조건 A › Results & Discussions\n수율 82%\n\n### Conclusions and Discussion\n결론 메모'
    );
    expect(extractResultSections('## [WD010 A]\n### [UHW010 Spin]\n#### Method\n1. 원심분리')).toBe('');
  });

  it("reads a software unit operation's Output, not a lab one's (#317)", () => {
    const md = [
      '## [WD010 A]',
      '### [UHW010 Spin]',
      '#### Output',
      '- DNA-1 정제물',
      '### [USW020 Align]',
      '#### Output',
      'F1 0.92, 정렬률 97%',
      '### [UXX030 Custom]',
      '#### Meta',
      '- Software: bowtie2',
      '#### Output',
      'BAM 3개',
    ].join('\n');
    expect(extractResultSections(md)).toBe(
      '### [USW020 Align] › Output\nF1 0.92, 정렬률 97%\n\n### [UXX030 Custom] › Output\nBAM 3개'
    );
    expect(hasRecordedResults(md.split('### [USW020')[0])).toBe(false);
    expect(hasRecordedResults(md)).toBe(true);
  });

  it('sends an issue marker as its topic sentence (#354)', () => {
    const md = '## [WD010 A]\n### [UHW010 Spin]\n#### Results & Discussions\n수율 40%. @issue;ISS-abc;시드 배양 시간 차이\n```\n@issue;ISS-x;예시\n```';
    expect(extractResultSections(md)).toBe(
      '### [UHW010 Spin] › Results & Discussions\n수율 40%. 시드 배양 시간 차이\n```\n@issue;ISS-x;예시\n```'
    );
  });
});

describe('maskAiCallouts (#318)', () => {
  it('blanks the callout but keeps every offset and line', () => {
    const md = ['DNA-1;원본', '> [!note] AI 요약 (m)', '> - DNA-1;원본 사용', '', 'after'].join('\n');
    const masked = maskAiCallouts(md);
    expect(masked.length).toBe(md.length);
    const lines = md.split('\n');
    expect(masked.split('\n')).toEqual(['DNA-1;원본', ' '.repeat(lines[1].length), ' '.repeat(lines[2].length), '', 'after']);
    expect(maskAiCallouts('> [!warning] 주의')).toBe('> [!warning] 주의');
  });
});

describe('dropEchoedLines (#316)', () => {
  const memo = '검토 의견(시료 담당): 절편 SEC-N의 두께와 프로브 패널 버전(PNL-300)이 노트에 없음. 음성대조 배경 단위가 적혀 있지 않음.';

  it('drops a line that only repeats the memo, label or spacing aside', () => {
    const reply = [
      '* 확장 거리 3, 5, 8 um 에서 할당 수율이 각각 49%, 58%, 63% 로 나타남.',
      '절편 SEC-N 의 두께와 프로브 패널 버전(PNL-300) 이 노트에 없음. 음성대조 배경 단위가 적혀 있지 않음.',
      '검토 의견 (시료 담당): 절편 SEC-N 의 두께와 프로브 패널 버전(PNL-300) 이 노트에 없음. 음성대조 배경 단위가 적혀 있지 않음.',
    ].join('\n');
    expect(dropEchoedLines(reply, memo)).toBe(reply.split('\n')[0]);
  });

  it('keeps short lines, unrelated lines, and the whole reply when nothing else is left', () => {
    expect(dropEchoedLines('- 없음', '없음')).toBe('- 없음');
    expect(dropEchoedLines('- 수율 63%', memo)).toBe('- 수율 63%');
    expect(dropEchoedLines(memo, memo)).toBe(memo);
  });
});

// #306: one long note took the whole budget of an experiment summary.
describe('shareBudget', () => {
  it('gives what short texts leave to the long ones', () => {
    expect(shareBudget([100, 5000, 9000], 6000)).toEqual([100, 2950, 2950]);
    expect(shareBudget([10, 20], 100)).toEqual([10, 20]);
    expect(shareBudget([], 100)).toEqual([]);
  });
});
