import { findAiCalloutInSection, locateSummary, planSectionAppend, sectionText } from '../sections/summaryInsert';

const README = '## 🗂️ Related Workflows\n- [ ] a\n\n## Summary and Discussion\n\n메모\n\n\n## 부록\n표\n';

describe('planSectionAppend', () => {
  it('puts a block after the last written line of the section', () => {
    const plan = planSectionAppend(README, 'Summary and Discussion', '> [!note] X')!;
    const out = README.slice(0, plan.offset) + plan.text + README.slice(plan.offset);
    expect(out).toBe('## 🗂️ Related Workflows\n- [ ] a\n\n## Summary and Discussion\n\n메모\n\n> [!note] X\n\n\n## 부록\n표\n');
  });

  it('ends a section at the end of the note with a newline, and fills an empty one', () => {
    const md = '## Conclusions and Discussion\n\n\n';
    const plan = planSectionAppend(md, 'Conclusions and Discussion', '> [!note] X')!;
    expect(md.slice(0, plan.offset) + plan.text + md.slice(plan.offset)).toBe('## Conclusions and Discussion\n\n> [!note] X\n\n\n');
    const bare = '## Conclusions and Discussion\n결론';
    const p2 = planSectionAppend(bare, 'Conclusions and Discussion', 'B')!;
    expect(bare.slice(0, p2.offset) + p2.text).toBe('## Conclusions and Discussion\n결론\n\nB\n');
    expect(planSectionAppend(bare, 'Summary and Discussion', 'B')).toBeUndefined();
  });
});

describe('findAiCalloutInSection / sectionText', () => {
  const md = '## Summary and Discussion\n메모\n\n> [!note] AI 실험 결과 요약 (m, 2026-01-01)\n> - a\n>\n> - b\n\n## 부록\n> [!note] AI 실험 결과 요약 (m, d)\n';

  it('finds the summary an earlier run wrote in that section only', () => {
    const r = findAiCalloutInSection(md, 'Summary and Discussion', ['AI experiment results summary', 'AI 실험 결과 요약'])!;
    expect(md.slice(r.start, r.end)).toBe('> [!note] AI 실험 결과 요약 (m, 2026-01-01)\n> - a\n>\n> - b');
    expect(findAiCalloutInSection(md, 'Summary and Discussion', ['AI workflow results summary'])).toBeUndefined();
  });

  it('reads the text of a section', () => {
    expect(sectionText(md, 'Summary and Discussion')).toContain('메모');
    expect(sectionText(md, '없는 절')).toBeUndefined();
  });
});

// #319: a renamed heading sent every new summary to the end of the note.
describe('locateSummary', () => {
  const titles = ['AI experiment results summary', 'AI 실험 결과 요약'];
  const renamed =
    '## 목적\n\n## 요약과 논의\n메모\n\n> [!note] AI 실험 결과 요약 (m, d)\n> - a\n\n---\n\n## 부록\n```\n> [!note] AI 실험 결과 요약 (예시)\n```\n';

  it('takes the named section, else the one holding the last earlier summary outside code, else the end', () => {
    expect(locateSummary(README, 'Summary and Discussion', titles)).toEqual({ kind: 'named', heading: 'Summary and Discussion' });
    expect(locateSummary(renamed, 'Summary and Discussion', titles)).toEqual({ kind: 'callout', heading: '요약과 논의' });
    expect(locateSummary('## 목적\n', 'Summary and Discussion', titles)).toEqual({ kind: 'end' });
  });

  it('replaces the earlier summary and reads the memo under the renamed heading', () => {
    const r = findAiCalloutInSection(renamed, 'Summary and Discussion', titles)!;
    expect(renamed.slice(r.start, r.end)).toBe('> [!note] AI 실험 결과 요약 (m, d)\n> - a');
    expect(sectionText(renamed, 'Summary and Discussion', titles)).toBe('메모\n\n> [!note] AI 실험 결과 요약 (m, d)\n> - a');
    const plan = planSectionAppend(renamed, 'Summary and Discussion', 'B', titles)!;
    expect(renamed.slice(0, plan.offset)).toMatch(/> - a$/);
  });

  it('finds a summary above every heading', () => {
    const top = '> [!note] AI 실험 결과 요약 (m, d)\n> - a\n\n## 부록\n';
    expect(locateSummary(top, 'Summary and Discussion', titles)).toEqual({ kind: 'callout', heading: '' });
    const r = findAiCalloutInSection(top, 'Summary and Discussion', titles)!;
    expect(top.slice(r.start, r.end)).toBe('> [!note] AI 실험 결과 요약 (m, d)\n> - a');
  });
});

// #332: a section's body stopped after the --- that opens the next unit operation.
describe('planSectionAppend before a separator', () => {
  it('puts the block above the --- before the next heading', () => {
    const md = '### [UHW010 A]\n#### Discussion\n메모\n\n---\n\n### [UHW020 B]\n';
    const plan = planSectionAppend(md, 'Discussion', 'X')!;
    expect(md.slice(0, plan.offset) + plan.text + md.slice(plan.offset)).toBe(
      '### [UHW010 A]\n#### Discussion\n메모\n\nX\n\n---\n\n### [UHW020 B]\n'
    );
  });
});
