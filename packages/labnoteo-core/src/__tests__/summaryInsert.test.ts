import { findAiCalloutInSection, planSectionAppend, sectionText } from '../sections/summaryInsert';

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
