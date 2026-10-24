/**
 * #257: "AI: Summarize results" on a note holding only the template answered
 * with measurements nobody had written down.
 */
import { describe, it, expect } from 'vitest';
import { createWorkflowContent } from '../lib/workflowStructure';
import { buildHwUnitOpMarkdown, buildSwUnitOpMarkdown } from '../lib/unitOpTemplate';
import { extractResultSections, shareBudget, hasRecordedResults, stripAiCallouts, stripTemplatePlaceholders } from '../lib/noteResults';

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
});

// #306: one long note took the whole budget of an experiment summary.
describe('shareBudget', () => {
  it('gives what short texts leave to the long ones', () => {
    expect(shareBudget([100, 5000, 9000], 6000)).toEqual([100, 2950, 2950]);
    expect(shareBudget([10, 20], 100)).toEqual([10, 20]);
    expect(shareBudget([], 100)).toEqual([]);
  });
});
