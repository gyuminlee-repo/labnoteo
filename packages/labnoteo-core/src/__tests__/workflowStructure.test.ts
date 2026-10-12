// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  parseExperimenterFromReadme,
  reconcileWorkflowChecklist,
  parseWorkflowChecklistFromReadme,
  updateReadmeWorkflowSection,
  generateWorkflowChecklist,
  sanitizeWorkflowName,
  planWorkflowRenumber,
  planRenumberMoves,
  buildRenumberStagingName,
  collapseWorkflowRenames,
  suggestWorkflowFileName,
  classifyWorkflowRename,
  createWorkflowContent,
} from '../lib/workflowStructure';
import { sanitizeTitle } from '../lib/labnoteStructure';

// #38: the unit-operation hint names the command as the palette shows it.
describe('createWorkflowContent command hint', () => {
  const wf = { id: 'WD010', name: 'Design', description: 'desc' };

  it('cites only the English name without a Korean locale', () => {
    for (const md of [
      createWorkflowContent(wf, 'Dr. Kim'),
      createWorkflowContent(wf, 'Dr. Kim', undefined, { locale: 'en' }),
    ]) {
      expect(md).toContain('run `Insert unit operation` to add one.');
      expect(md).not.toContain('유닛 오퍼레이션 삽입');
    }
  });

  it('adds the Korean name under a Korean locale', () => {
    for (const locale of ['ko', 'ko-KR']) {
      const md = createWorkflowContent(wf, 'Dr. Kim', 'Alias', { locale });
      expect(md).toContain('run `Insert unit operation` (`유닛 오퍼레이션 삽입`) to add one.');
      expect(md).toContain('## [WD010 Design] Alias');
    }
  });
});

/** Build a minimal README with a "Related Workflows" section from raw lines. */
function readmeWith(lines: string[]): string {
  return ['# Experiment', '', '## Related Workflows', '', ...lines, '', '## Notes', '', 'body'].join(
    '\n'
  );
}

describe('parseExperimenterFromReadme', () => {
  it('reads a quoted author without the surrounding quotes', () => {
    const md = ['---', "author: 'Dr. Kim'", "created_date: '2024-01-01'", '---', '', '# Note'].join(
      '\n'
    );
    expect(parseExperimenterFromReadme(md)).toBe('Dr. Kim');
  });

  it('issue #36: an empty author does not swallow the next line', () => {
    const md = ['---', 'author:', "created_date: '2024-01-01'", '---'].join('\n');
    expect(parseExperimenterFromReadme(md)).toBe('');
  });

  it('returns empty string when there is no front matter', () => {
    expect(parseExperimenterFromReadme('# Just a note')).toBe('');
  });
});

describe('reconcileWorkflowChecklist', () => {
  it('reorders checklist entries by numeric NNN prefix', () => {
    const readme = readmeWith([
      '- [ ] [Design](./002_WD010_Design.labnote.md)',
      '- [x] [Assay](./001_WS010_Assay.labnote.md)',
    ]);
    const res = reconcileWorkflowChecklist(readme, []);
    expect(res.changed).toBe(true);
    const order = parseWorkflowChecklistFromReadme(res.content).map(i => i.fileName);
    expect(order).toEqual(['001_WS010_Assay.labnote.md', '002_WD010_Design.labnote.md']);
  });

  it('remaps a renamed file (old->new basename) and re-sorts by the new NNN', () => {
    const readme = readmeWith([
      '- [ ] [Assay](./001_WS010_Assay.labnote.md)',
      '- [ ] [Design](./002_WD010_Design.labnote.md)',
    ]);
    const res = reconcileWorkflowChecklist(readme, [
      { from: '001_WS010_Assay.labnote.md', to: '003_WS010_Assay.labnote.md' },
    ]);
    expect(res.changed).toBe(true);
    const order = parseWorkflowChecklistFromReadme(res.content).map(i => i.fileName);
    // 002 now sorts before the renamed 003; the link followed the file.
    expect(order).toEqual(['002_WD010_Design.labnote.md', '003_WS010_Assay.labnote.md']);
  });

  it('keeps non-standard/manual links after the standard ones', () => {
    const readme = readmeWith([
      '- [ ] [Manual](./manual-notes.labnote.md)',
      '- [ ] [Second](./002_WD010_Second.labnote.md)',
      '- [ ] [First](./001_WD010_First.labnote.md)',
    ]);
    const res = reconcileWorkflowChecklist(readme, []);
    expect(res.changed).toBe(true);
    const order = parseWorkflowChecklistFromReadme(res.content).map(i => i.fileName);
    expect(order).toEqual([
      '001_WD010_First.labnote.md',
      '002_WD010_Second.labnote.md',
      'manual-notes.labnote.md',
    ]);
  });

  it('is idempotent: a second pass with no renames reports no change', () => {
    const readme = readmeWith([
      '- [ ] [Design](./002_WD010_Design.labnote.md)',
      '- [ ] [Assay](./001_WS010_Assay.labnote.md)',
    ]);
    const first = reconcileWorkflowChecklist(readme, []);
    const second = reconcileWorkflowChecklist(first.content, []);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('returns no change when there is no Related Workflows section', () => {
    const md = ['# Note', '', 'Just some text.'].join('\n');
    const res = reconcileWorkflowChecklist(md, [
      { from: '001_WD010_A.labnote.md', to: '002_WD010_A.labnote.md' },
    ]);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(md);
  });
});

// The section rewriter used to consume every `[ ]`/`- [x]` line it found, but
// only `.labnote.md` links were parsed back out and regenerated. Everything in
// between was deleted with no message — and this section is exactly where a
// researcher keeps loose to-dos, so the loss was routine rather than exotic.
describe('updateReadmeWorkflowSection preserves lines it does not own', () => {
  const entry = (n: string, title: string) => `- [ ] [${title}](./${n}.labnote.md)`;

  it("keeps the researcher's own checkbox lines", () => {
    const readme = readmeWith([
      entry('001_WD010_Design', 'Design'),
      '- [ ] 김박사님께 annealing 온도 문의',
      '- [x] 시약 재주문',
    ]);

    const updated = updateReadmeWorkflowSection(
      readme,
      generateWorkflowChecklist([
        { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
        { done: false, title: 'Assay', fileName: '002_WS010_Assay.labnote.md' },
      ])
    );

    expect(updated).toContain('- [ ] 김박사님께 annealing 온도 문의');
    expect(updated).toContain('- [x] 시약 재주문');
    expect(updated).toContain('002_WS010_Assay.labnote.md');
  });

  it('keeps a checkbox link that points somewhere other than a workflow note', () => {
    const readme = readmeWith([entry('001_WD010_Design', 'Design'), '- [x] [protocol](./protocol.md)']);

    const updated = updateReadmeWorkflowSection(
      readme,
      generateWorkflowChecklist([
        { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
      ])
    );

    expect(updated).toContain('- [x] [protocol](./protocol.md)');
  });

  it('keeps prose and the instruction blockquote', () => {
    const readme = readmeWith([
      '> 워크플로를 추가하려면 명령 팔레트를 사용하세요.',
      '',
      entry('001_WD010_Design', 'Design'),
      '',
      '재현성 관련 메모는 아래 Notes 절에 적었습니다.',
    ]);

    const updated = updateReadmeWorkflowSection(
      readme,
      generateWorkflowChecklist([
        { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
      ])
    );

    expect(updated).toContain('> 워크플로를 추가하려면 명령 팔레트를 사용하세요.');
    expect(updated).toContain('재현성 관련 메모는 아래 Notes 절에 적었습니다.');
  });

  it('groups regenerated entries where the first one was', () => {
    // Entries interleaved with a note must not end up split across it.
    const readme = readmeWith([
      entry('002_WD010_Second', 'Second'),
      '- [ ] 손으로 적은 할 일',
      entry('001_WD010_First', 'First'),
    ]);

    const { content } = reconcileWorkflowChecklist(readme, []);
    const lines = content.split('\n');
    const first = lines.findIndex(l => l.includes('001_WD010_First'));
    const second = lines.findIndex(l => l.includes('002_WD010_Second'));

    expect(second).toBe(first + 1);
    expect(content).toContain('- [ ] 손으로 적은 할 일');
  });

  it('does not touch a checkbox line in a later section', () => {
    const readme = [
      '## Related Workflows',
      '',
      entry('001_WD010_Design', 'Design'),
      '',
      '## Notes',
      '',
      '- [ ] [Other](./999_WD999_Other.labnote.md)',
    ].join('\n');

    const updated = updateReadmeWorkflowSection(
      readme,
      generateWorkflowChecklist([
        { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
      ])
    );

    expect(updated).toContain('- [ ] [Other](./999_WD999_Other.labnote.md)');
  });

  it('inserts after the blockquote when the section has no entries yet', () => {
    const readme = readmeWith(['> 지침 문구']);

    const updated = updateReadmeWorkflowSection(
      readme,
      generateWorkflowChecklist([
        { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
      ])
    );

    const lines = updated.split('\n');
    const quote = lines.findIndex(l => l.startsWith('> '));
    const inserted = lines.findIndex(l => l.includes('001_WD010_Design'));
    expect(inserted).toBeGreaterThan(quote);
    expect(lines[inserted - 1].trim()).toBe('');
  });
});

describe('planWorkflowRenumber', () => {
  it('closes gaps while keeping the current order', () => {
    expect(
      planWorkflowRenumber([
        '001_WD010_First.labnote.md',
        '005_WS010_Second.labnote.md',
        '009_WD020_Third.labnote.md',
      ])
    ).toEqual([
      { from: '005_WS010_Second.labnote.md', to: '002_WS010_Second.labnote.md' },
      { from: '009_WD020_Third.labnote.md', to: '003_WD020_Third.labnote.md' },
    ]);
  });

  it('gives duplicated numbers distinct sequential ones', () => {
    expect(
      planWorkflowRenumber(['001_WD020_Beta.labnote.md', '001_WD010_Alpha.labnote.md'])
    ).toEqual([{ from: '001_WD020_Beta.labnote.md', to: '002_WD020_Beta.labnote.md' }]);
  });

  it('plans nothing when the folder is already sequential', () => {
    expect(
      planWorkflowRenumber(['001_WD010_A.labnote.md', '002_WD010_B.labnote.md'])
    ).toEqual([]);
  });

  it('ignores the README and any non-standard file name', () => {
    expect(
      planWorkflowRenumber([
        'README.labnote.md',
        'notes.md',
        'manual-notes.labnote.md',
        '004_WD010_Only.labnote.md',
      ])
    ).toEqual([{ from: '004_WD010_Only.labnote.md', to: '001_WD010_Only.labnote.md' }]);
  });

  it('preserves a Korean name verbatim rather than re-sanitizing it', () => {
    expect(planWorkflowRenumber(['003_WD010_실험_1.labnote.md'])).toEqual([
      { from: '003_WD010_실험_1.labnote.md', to: '001_WD010_실험_1.labnote.md' },
    ]);
  });
});

describe('buildRenumberStagingName', () => {
  it('stages under a name that is still a valid, parseable workflow file', () => {
    const staged = buildRenumberStagingName(
      { from: '002_WD010_A.labnote.md', to: '001_WD010_A.labnote.md' },
      0
    );
    expect(staged).toBe('001_WD010_A_staging0.labnote.md');
  });

  it('keeps two files that swap numbers apart while staged', () => {
    const renames = planWorkflowRenumber([
      '002_WD010_A.labnote.md',
      '002_WD020_B.labnote.md',
      '001_WD030_C.labnote.md',
    ]);
    const staged = renames.map((r, i) => buildRenumberStagingName(r, i));
    expect(new Set(staged).size).toBe(staged.length);
    // No staging name collides with a name still on disk.
    for (const name of staged) {
      expect(renames.some(r => r.from === name)).toBe(false);
    }
  });
});

describe('planRenumberMoves', () => {
  /** Apply `moves` to `names`, failing if a move lands on a name still taken. */
  function simulate(names: string[], moves: { from: string; to: string }[]): Set<string> {
    const disk = new Set(names);
    for (const { from, to } of moves) {
      expect(disk.has(from)).toBe(true);
      expect(disk.has(to)).toBe(false);
      disk.delete(from);
      disk.add(to);
    }
    return disk;
  }

  function expectedNames(names: string[]): Set<string> {
    const plan = planWorkflowRenumber(names);
    const disk = new Set(names);
    for (const { from } of plan) disk.delete(from);
    for (const { to } of plan) disk.add(to);
    return disk;
  }

  // #41: one rename per file, so Obsidian asks about links once per file and
  // no `_staging` name ever shows up.
  it('moves straight to the target when closing gaps', () => {
    const names = [
      'README.labnote.md',
      '001_WD070_A.labnote.md',
      '003_WB030_B.labnote.md',
      '007_WT020_C.labnote.md',
    ];
    const moves = planRenumberMoves(planWorkflowRenumber(names), names);
    expect(moves).toEqual(planWorkflowRenumber(names));
    expect(moves.some(m => m.to.includes('_staging'))).toBe(false);
    expect(simulate(names, moves)).toEqual(expectedNames(names));
  });

  it('parks a file only while its target is still taken', () => {
    // The duplicated 001_WD010_B moves up to 002_WD010_B, a name the next file
    // still holds until it moves on to 003.
    const names = [
      '001_WD010_A.labnote.md',
      '001_WD010_B.labnote.md',
      '002_WD010_B.labnote.md',
    ];
    const moves = planRenumberMoves(planWorkflowRenumber(names), names);
    expect(moves).toEqual([
      { from: '001_WD010_B.labnote.md', to: '002_WD010_B_staging0.labnote.md' },
      { from: '002_WD010_B.labnote.md', to: '003_WD010_B.labnote.md' },
      { from: '002_WD010_B_staging0.labnote.md', to: '002_WD010_B.labnote.md' },
    ]);
    expect(simulate(names, moves)).toEqual(expectedNames(names));
  });

  it('plans nothing for an already sequential folder', () => {
    const names = ['001_WD010_A.labnote.md', '002_WD010_B.labnote.md'];
    expect(planRenumberMoves(planWorkflowRenumber(names), names)).toEqual([]);
  });
});

describe('reconcileWorkflowChecklist with a baseline', () => {
  // #41 review: two workflows with the same id and name. 001 was deleted, so
  // P (002) becomes 001 and Q (003) becomes 002 — Q's new name is P's old one.
  const P_OLD = '002_WB030_웨스턴.labnote.md';
  const Q_OLD = '003_WB030_웨스턴.labnote.md';
  const P_NEW = '001_WB030_웨스턴.labnote.md';
  const Q_NEW = '002_WB030_웨스턴.labnote.md';
  const renames = [
    { from: P_OLD, to: P_NEW },
    { from: Q_OLD, to: Q_NEW },
  ];
  const before = readmeWith([`- [ ] [P](./${P_OLD})`, `- [ ] [Q](./${Q_OLD})`]);
  const linksOf = (md: string): string[] =>
    parseWorkflowChecklistFromReadme(md).map(i => `${i.title}:${i.fileName}`);

  it('remaps an already-updated link a second time without a baseline', () => {
    const updatedByObsidian = readmeWith([`- [ ] [P](${P_NEW})`, `- [ ] [Q](${Q_NEW})`]);
    const res = reconcileWorkflowChecklist(updatedByObsidian, renames);
    expect(linksOf(res.content)).not.toEqual([`P:${P_NEW}`, `Q:${Q_NEW}`]);
  });

  it('links each entry to its own file whether or not Obsidian updated the links', () => {
    const updatedByObsidian = readmeWith([`- [ ] [P](${P_NEW})`, `- [ ] [Q](${Q_NEW})`]);
    for (const current of [before, updatedByObsidian]) {
      const res = reconcileWorkflowChecklist(current, renames, { baseline: before });
      expect(linksOf(res.content)).toEqual([`P:${P_NEW}`, `Q:${Q_NEW}`]);
    }
  });

  it('keeps the current text outside the checklist', () => {
    const current = [
      '# Experiment',
      '',
      '## Related Workflows',
      '',
      `- [ ] [P](${P_NEW})`,
      `- [ ] [Q](${Q_NEW})`,
      '',
      '## Summary and Discussion',
      '',
      `요약 글 [[${Q_NEW}]]`,
    ].join('\n');
    const res = reconcileWorkflowChecklist(current, renames, { baseline: before });
    expect(res.content).toContain('\n## Summary and Discussion\n\n요약 글 [[' + Q_NEW + ']]');
    expect(linksOf(res.content)).toEqual([`P:${P_NEW}`, `Q:${Q_NEW}`]);
  });
});

describe('collapseWorkflowRenames', () => {
  it('collapses a staged two-hop rename into a single hop', () => {
    expect(
      collapseWorkflowRenames([
        { from: '002_WD010_A.labnote.md', to: '001_WD010_A_staging0.labnote.md' },
        { from: '001_WD010_A_staging0.labnote.md', to: '001_WD010_A.labnote.md' },
      ])
    ).toEqual([{ from: '002_WD010_A.labnote.md', to: '001_WD010_A.labnote.md' }]);
  });

  it('drops a rename that ends back at the original name', () => {
    expect(
      collapseWorkflowRenames([
        { from: '001_WD010_A.labnote.md', to: '002_WD010_A.labnote.md' },
        { from: '002_WD010_A.labnote.md', to: '001_WD010_A.labnote.md' },
      ])
    ).toEqual([]);
  });
});

describe('reconcileWorkflowChecklist with staged renames', () => {
  it('relinks to the final name, not the staging one', () => {
    const readme = readmeWith([
      '- [ ] [A](./002_WD010_A.labnote.md)',
      '- [ ] [B](./001_WD020_B.labnote.md)',
    ]);
    // What the vault rename listener records for a two-file swap.
    const res = reconcileWorkflowChecklist(readme, [
      { from: '002_WD010_A.labnote.md', to: '001_WD010_A_staging0.labnote.md' },
      { from: '001_WD020_B.labnote.md', to: '002_WD020_B_staging1.labnote.md' },
      { from: '001_WD010_A_staging0.labnote.md', to: '001_WD010_A.labnote.md' },
      { from: '002_WD020_B_staging1.labnote.md', to: '002_WD020_B.labnote.md' },
    ]);
    const order = parseWorkflowChecklistFromReadme(res.content).map(i => i.fileName);
    expect(order).toEqual(['001_WD010_A.labnote.md', '002_WD020_B.labnote.md']);
  });
});

describe('suggestWorkflowFileName', () => {
  it('moves .labnote back to the end when text was typed after it (#33)', () => {
    expect(suggestWorkflowFileName('001_WB030_Gibson.labnote v3.md')).toBe(
      '001_WB030_Gibson v3.labnote.md'
    );
    expect(suggestWorkflowFileName('001_WB030_Gibson.labnote_재조립.md')).toBe(
      '001_WB030_Gibson_재조립.labnote.md'
    );
  });

  it('adds .labnote when it was removed', () => {
    expect(suggestWorkflowFileName('001_WB030_Gibson v3.md')).toBe('001_WB030_Gibson v3.labnote.md');
  });

  it('matches .labnote case-insensitively', () => {
    expect(suggestWorkflowFileName('001_WB030_Gibson.LABNOTE v3.md')).toBe(
      '001_WB030_Gibson v3.labnote.md'
    );
  });

  it('does not guess without the ###_ prefix or for an already valid name', () => {
    expect(suggestWorkflowFileName('WB030_Gibson.labnote v3.md')).toBeUndefined();
    expect(suggestWorkflowFileName('001_WB030_Gibson.labnote.md')).toBeUndefined();
  });
});

describe('classifyWorkflowRename', () => {
  const dir = 'labnote/001_Exp';
  const valid = `${dir}/001_WB030_Gibson.labnote.md`;
  const broken = `${dir}/001_WB030_Gibson.labnote v3.md`;
  const fixed = `${dir}/001_WB030_Gibson v3.labnote.md`;

  it('relinks a valid → valid rename', () => {
    expect(classifyWorkflowRename(valid, fixed)).toEqual({
      kind: 'renamed',
      dir,
      from: '001_WB030_Gibson.labnote.md',
      to: '001_WB030_Gibson v3.labnote.md',
    });
  });

  it('reports a valid → invalid rename as broken, with a suggested name', () => {
    expect(classifyWorkflowRename(valid, broken)).toEqual({
      kind: 'broken',
      dir,
      origin: '001_WB030_Gibson.labnote.md',
      suggestion: '001_WB030_Gibson v3.labnote.md',
    });
  });

  it('reports a broken rename without a suggestion when none is safe', () => {
    expect(classifyWorkflowRename(valid, `${dir}/Gibson notes.md`)).toEqual({
      kind: 'broken',
      dir,
      origin: '001_WB030_Gibson.labnote.md',
    });
  });

  it('restores from the original name once a broken note is valid again', () => {
    expect(classifyWorkflowRename(broken, fixed, '001_WB030_Gibson.labnote.md')).toEqual({
      kind: 'restored',
      dir,
      from: '001_WB030_Gibson.labnote.md',
      to: '001_WB030_Gibson v3.labnote.md',
    });
  });

  it('keeps tracking a broken note renamed to another broken name', () => {
    expect(
      classifyWorkflowRename(broken, `${dir}/001_WB030_Gibson v4.md`, '001_WB030_Gibson.labnote.md')
    ).toEqual({ kind: 'strayMoved', dir, origin: '001_WB030_Gibson.labnote.md' });
  });

  it('ignores invalid → valid without a known origin (as before)', () => {
    expect(classifyWorkflowRename(broken, fixed)).toBeNull();
  });

  it('ignores moves to another folder or into a subfolder', () => {
    expect(classifyWorkflowRename(valid, 'labnote/002_Other/001_WB030_Gibson.labnote.md')).toBeNull();
    expect(classifyWorkflowRename(valid, `${dir}/sub/001_WB030_Gibson.labnote.md`)).toBeNull();
  });

  it('relinks the README entry after broken → restored', () => {
    const readme = readmeWith([
      '- [ ] [Gibson](./001_WB030_Gibson.labnote.md)',
      '- [ ] [Next](./002_WB040_Next.labnote.md)',
    ]);
    const breakIt = classifyWorkflowRename(valid, broken);
    expect(breakIt?.kind).toBe('broken');
    const origin = breakIt?.kind === 'broken' ? breakIt.origin : undefined;
    const restore = classifyWorkflowRename(broken, fixed, origin);
    expect(restore?.kind).toBe('restored');
    if (restore?.kind !== 'restored') return;

    const res = reconcileWorkflowChecklist(readme, [{ from: restore.from, to: restore.to }]);
    expect(parseWorkflowChecklistFromReadme(res.content).map(i => i.fileName)).toEqual([
      '001_WB030_Gibson v3.labnote.md',
      '002_WB040_Next.labnote.md',
    ]);
  });
});

describe('shared path-segment sanitizer', () => {
  it('folder and file sanitizers agree on the same unicode rule', () => {
    // Both now delegate to sanitizePathSegment (Unicode letters/numbers kept).
    const input = 'Sample: 실험 (A/B) 1';
    expect(sanitizeTitle(input)).toBe(sanitizeWorkflowName(input));
  });

  it('keeps Korean letters and digits, drops punctuation, collapses underscores', () => {
    expect(sanitizeWorkflowName('실험 A/B: 1')).toBe('실험_AB_1');
  });

  // #25: ranges must stay readable in folder/file names.
  it('keeps hyphens and maps dashes and range tildes to an ASCII hyphen', () => {
    expect(sanitizeTitle('배지 최적화 1차 (M1–M8)')).toBe('배지_최적화_1차_M1-M8');
    expect(sanitizeTitle('배지 최적화 2차 (M9-M12)')).toBe('배지_최적화_2차_M9-M12');
    expect(sanitizeTitle('시료 M1~M8')).toBe('시료_M1-M8');
    expect(sanitizeWorkflowName('Micro-scale Parallel Cell Culture')).toBe('Micro-scale_Parallel_Cell_Culture');
  });

  // #26: a sign before a number keeps its meaning (−80 °C is not 80 °C).
  it('keeps a minus sign before a number, with the separator before it', () => {
    expect(sanitizeTitle('보관 −80°C')).toBe('보관_-80C');
    expect(sanitizeTitle('−80°C 보관')).toBe('-80C_보관');
    expect(sanitizeTitle('-80°C 보관')).toBe('-80C_보관');
    expect(sanitizeTitle('냉동고 -20°C 시료')).toBe('냉동고_-20C_시료');
    expect(sanitizeTitle('보관 (−80°C)')).toBe('보관_-80C');
    expect(sanitizeWorkflowName('Storage at －20 C')).toBe('Storage_at_-20_C');
  });

  it('still reads a dash between numbers or around spaces as a range', () => {
    expect(sanitizeTitle('시료 1–8')).toBe('시료_1-8');
    expect(sanitizeTitle('10 - 20')).toBe('10-20');
    expect(sanitizeTitle('M1 –M8')).toBe('M1-M8');
  });

  it('reduces a separator run containing a hyphen to one hyphen and trims edges', () => {
    expect(sanitizeTitle('M1 – M8')).toBe('M1-M8');
    expect(sanitizeTitle('a -- b')).toBe('a-b');
    expect(sanitizeTitle('- 제목 -')).toBe('제목');
  });
});
