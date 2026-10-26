// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  parseExperimenterFromReadme,
  reconcileWorkflowChecklist,
  parseWorkflowChecklistFromReadme,
  insertWorkflowChecklistEntries,
  isWorkflowChecklistEntryLine,
  workflowChecklistEntryLabel,
  workflowChecklistOrder,
  isMisnumberedWorkflowFileName,
  workflowNumberClashes,
  hasWorkflowChecklistSection,
  generateWorkflowChecklist,
  sanitizeWorkflowName,
  planWorkflowRenumber,
  matchMissingChecklistEntries,
  unitOpsAllEnded,
  planRenumberMoves,
  buildRenumberStagingName,
  collapseWorkflowRenames,
  suggestWorkflowFileName,
  suggestLinkableFileName,
  rebuildExperimentReadme,
  unlinkableNameChars,
  classifyWorkflowRename,
  createWorkflowContent,
  planWorkflowChecklistSync,
  removeWorkflowChecklistEntries,
  defaultWorkflowTitle,
  isCopiedWorkflowFileName,
  suggestCopiedWorkflowFileName,
  createWorkflowFileName,
  siblingTableCsvs,
  staleTableCsvs,
  orphanTableCsvs,
  planTableCsvMoves,
  planTableCsvNames,
  tableCsvName,
  labelMatchesFileName,
  workflowAliasProblem,
  decodeChecklistLink,
  workflowLabelFor,
  rewriteWorkflowTitle,
  parseWorkflowHeading,
  relabelWorkflowChecklistEntries,
  dedupeWorkflowChecklistEntries,
  normalizeWorkflowChecklistLabels,
  normalizeWorkflowChecklistLinks,
  normalizeChecklistLink,
  relinkWorkflowChecklistEntries,
  relinkCopiedExperimentChecklist,
  classifyWorkflowMoveOut,
  workflowAliasFromFileName,
  planWorkflowRetitle,
  workflowIdMismatch,
  planWorkflowExperimenterSync,
  resetCopiedWorkflowDates,
} from '../lib/workflowStructure';
import { sanitizeTitle } from '../lib/labnoteStructure';
import { WORKFLOW_FILE_NAME_MAX } from '../lib/regexUtils';

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

  // #394
  it.each([
    ['author:\n  - 이서연\n  - 박하늘', '이서연, 박하늘'],
    ['author: [이서연, 박하늘]', '이서연, 박하늘'],
    ['author: [[이서연]]', '이서연'],
    ['author:\n  - [[이서연]]\n  - "[[박하늘|하늘]]"', '이서연, 하늘'],
    ['author: "[[이서연#소속]]"', '이서연'],
    ['author: 42', '42'],
  ])('reads %j as names', (fm, names) => {
    expect(parseExperimenterFromReadme(`---\n${fm}\n---\n`)).toBe(names);
  });
});

// #160: a copy must not claim the original's dates.
describe('resetCopiedWorkflowDates', () => {
  it('dates the copy today and empties end and unit-op dates', () => {
    const src = [
      '---',
      'title: WD030 Design',
      "created_date: '2026-09-01'",
      'last_updated_date: 2026-09-30',
      'end_date: 2026-09-30',
      '---',
      '',
      '### [UHW010 PCR]',
      "- Start_date: '2026-09-02 09:00'",
      '- End_date: 2026-09-03 18:00',
      '```',
      "- Start_date: '2026-09-02 09:00'",
      '```',
    ].join('\r\n');
    const out = resetCopiedWorkflowDates(src, '2026-10-19');
    expect(out.split('\r\n')).toEqual([
      '---',
      'title: WD030 Design',
      'created_date: 2026-10-19',
      'last_updated_date: 2026-10-19',
      "end_date: ''",
      '---',
      '',
      '### [UHW010 PCR]',
      "- Start_date: ''",
      "- End_date: ''",
      '```',
      "- Start_date: '2026-09-02 09:00'",
      '```',
    ]);
  });

  it('leaves a note without those dates as it is', () => {
    const src = '---\ntitle: X\n---\n\n- End_date: \'\'\n';
    expect(resetCopiedWorkflowDates(src, '2026-10-19')).toBe(src);
  });
});

// #83: the README author fills in the workflow notes that name nobody.
describe('planWorkflowExperimenterSync', () => {
  const note = (fm: string, body = '') => `---\ntitle: WD030 Design\n${fm}\n---\n\n## [WD030 Design]\n${body}`;

  it('fills the empty front matter and the empty unit-op lines, keeping the named ones', () => {
    const body = '\n- Experimenter: 홍길동\n- Experimenter:\n- Experimenter: 김철수\n';
    expect(planWorkflowExperimenterSync(note("experimenter: ''", body), '이영희')).toEqual({
      from: '',
      to: '이영희',
      content: note('experimenter: 이영희', '\n- Experimenter: 홍길동\n- Experimenter: 이영희\n- Experimenter: 김철수\n'),
      unitOpLines: 1,
      skippedLines: 0,
      skippedEmptyLines: 0,
    });
  });

  // #404: each note may be someone else's than the README author's.
  it('leaves a note that names an experimenter alone', () => {
    expect(planWorkflowExperimenterSync(note('experimenter: 홍길동', '\n- Experimenter:\n'), '이영희')).toBeUndefined();
    expect(planWorkflowExperimenterSync(note('experimenter: [[홍길동]]'), '이영희')).toBeUndefined();
  });

  it('replaces an empty list under the key', () => {
    expect(planWorkflowExperimenterSync(note('experimenter:\n  -\nstatus: planned'), '이영희')?.content).toBe(
      note('experimenter: 이영희\nstatus: planned')
    );
  });

  // #155, #193: an empty line kept in a finished unit op is counted apart.
  it('keeps the empty experimenter lines of finished unit ops and counts them', () => {
    const op = (who: string, end: string) => `\n- Experimenter: ${who}\n- End_date: '${end}'\n`;
    const body = `### [UHW010 PCR]${op('', '2026-10-19 18:00')}### [UHW020 Gel]${op('', '')}`;
    const out = planWorkflowExperimenterSync(note("experimenter: ''", body), '이영희');
    expect(out?.content).toBe(
      note('experimenter: 이영희', `### [UHW010 PCR]${op('', '2026-10-19 18:00')}### [UHW020 Gel]${op('이영희', '')}`)
    );
    expect(out).toMatchObject({ unitOpLines: 1, skippedLines: 1, skippedEmptyLines: 1 });
  });

  it('fills an empty experimenter and keeps CRLF', () => {
    const crlf = note("experimenter: ''", '\n- Experimenter: \n').replace(/\n/g, '\r\n');
    const out = planWorkflowExperimenterSync(crlf, '이영희');
    expect(out?.from).toBe('');
    expect(out?.content).toBe(note('experimenter: 이영희', '\n- Experimenter: 이영희\n').replace(/\n/g, '\r\n'));
  });

  it('leaves Experimenter lines in code blocks alone', () => {
    const body = '\n```\n- Experimenter:\n```\n';
    expect(planWorkflowExperimenterSync(note("experimenter: ''", body), '이영희')?.content).toBe(
      note('experimenter: 이영희', body)
    );
  });

  it('does nothing without an author, an experimenter key, or a difference', () => {
    expect(planWorkflowExperimenterSync(note("experimenter: ''"), '  ')).toBeUndefined();
    expect(planWorkflowExperimenterSync(note('status: planned'), '이영희')).toBeUndefined();
    expect(planWorkflowExperimenterSync(note("experimenter: '이영희'"), '이영희')).toBeUndefined();
  });
});

describe('reconcileWorkflowChecklist', () => {
  it('leaves the checklist order alone without renames (#289)', () => {
    const readme = readmeWith([
      '- [ ] [Design](./002_WD010_Design.labnote.md)',
      '- [x] [Assay](./001_WS010_Assay.labnote.md)',
    ]);
    const res = reconcileWorkflowChecklist(readme, []);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(readme);
  });

  it('relinks a renamed file in place unless asked to move it', () => {
    const readme = readmeWith([
      '- [ ] [Assay](./001_WS010_Assay.labnote.md)',
      '- [ ] [Design](./002_WD010_Design.labnote.md)',
    ]);
    const renames = [{ from: '001_WS010_Assay.labnote.md', to: '003_WS010_Assay.labnote.md' }];
    const order = (md: string) => parseWorkflowChecklistFromReadme(md).map(i => i.fileName);
    expect(order(reconcileWorkflowChecklist(readme, renames).content)).toEqual([
      '003_WS010_Assay.labnote.md',
      '002_WD010_Design.labnote.md',
    ]);
    // Renamed in the explorer: the entry moves to its number.
    expect(order(reconcileWorkflowChecklist(readme, renames, { move: true }).content)).toEqual([
      '002_WD010_Design.labnote.md',
      '003_WS010_Assay.labnote.md',
    ]);
  });

  it('keeps non-standard/manual links where they are', () => {
    const readme = readmeWith([
      '- [ ] [Manual](./manual-notes.labnote.md)',
      '- [ ] [Second](./002_WD010_Second.labnote.md)',
      '- [ ] [First](./001_WD010_First.labnote.md)',
    ]);
    const res = reconcileWorkflowChecklist(readme, []);
    expect(res.changed).toBe(false);
    expect(res.content).toBe(readme);
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

// #102: Obsidian writes a vault-absolute link when another experiment has a
// file of the same name; the checklist must keep pointing at `./<file name>`.
describe('vault-absolute checklist links (#102)', () => {
  const DIR = 'labnote/042_단백질';
  const X = '001_WT030_Activity.labnote.md';

  it('reduces a link into the folder to its file name and leaves others alone', () => {
    expect(normalizeChecklistLink(`${DIR}/${X}`, DIR)).toBe(X);
    expect(normalizeChecklistLink(`/${DIR}/${X}`, DIR)).toBe(X);
    expect(normalizeChecklistLink(X, DIR)).toBe(X);
    expect(normalizeChecklistLink(`../038_B/${X}`, DIR)).toBe(`../038_B/${X}`);
    expect(normalizeChecklistLink(`labnote/038_B/${X}`, DIR)).toBe(`labnote/038_B/${X}`);
    expect(normalizeChecklistLink(`images/${X}`, DIR)).toBe(`images/${X}`);
  });

  it('relinks a renamed entry Obsidian made vault-absolute, keeping its checkbox', () => {
    const readme = readmeWith([
      '- [ ] [WB090 Purification](./001_WB090_Purification.labnote.md)',
      `- [x] [WT030 Activity](${DIR}/${X})`,
    ]);
    const res = reconcileWorkflowChecklist(readme, [{ from: '002_WT030_Activity.labnote.md', to: X }], { dir: DIR });
    expect(res.content).toContain(`- [x] [WT030 Activity](./${X})`);
    expect(res.content).not.toContain(`./${DIR}`);
  });

  it('repairs an entry an earlier version broke into ./labnote/…', () => {
    const readme = readmeWith([`- [ ] [WT030 Activity](./${DIR}/${X})`]);
    const res = reconcileWorkflowChecklist(readme, [], { dir: DIR });
    expect(res.changed).toBe(true);
    expect(res.content).toContain(`(./${X})`);
  });

  it('never writes ./ before a link with a folder part', () => {
    expect(generateWorkflowChecklist([{ done: false, title: 'B', fileName: `../038_B/${X}` }])).toBe(
      `- [ ] [B](../038_B/${X})`
    );
  });

  it('counts the folder file as listed instead of adding it again', () => {
    const readme = readmeWith([`- [ ] [WT030 Activity](${DIR}/${X})`]);
    const plan = planWorkflowChecklistSync(readme, [X], new Map(), undefined, DIR);
    expect(plan.added).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('shortens such links in place', () => {
    const readme = readmeWith([`- [x] [WT030 Activity](./${DIR}/${X})`, '- [ ] [B](./002_WB090_B.labnote.md)']);
    const { content, count } = normalizeWorkflowChecklistLinks(readme, DIR);
    expect(count).toBe(1);
    expect(content).toContain(`- [x] [WT030 Activity](./${X})`);
    expect(normalizeWorkflowChecklistLinks(content, DIR).count).toBe(0);
  });
});

// The section rewriter used to consume every `[ ]`/`- [x]` line it found, but
// only `.labnote.md` links were parsed back out and regenerated. Everything in
// between was deleted with no message — and this section is exactly where a
// researcher keeps loose to-dos, so the loss was routine rather than exotic.
describe('insertWorkflowChecklistEntries preserves lines it does not own', () => {
  const entry = (n: string, title: string) => `- [ ] [${title}](./${n}.labnote.md)`;
  const assay = { done: false, title: 'Assay', fileName: '002_WS010_Assay.labnote.md' };

  it("keeps the researcher's own checkbox lines", () => {
    const readme = readmeWith([
      entry('001_WD010_Design', 'Design'),
      '- [ ] 김박사님께 annealing 온도 문의',
      '- [x] 시약 재주문',
    ]);

    const updated = insertWorkflowChecklistEntries(readme, [assay]);

    expect(updated).toContain('- [ ] 김박사님께 annealing 온도 문의');
    expect(updated).toContain('- [x] 시약 재주문');
    expect(updated).toContain(entry('001_WD010_Design', 'Design') + '\n' + entry('002_WS010_Assay', 'Assay'));
  });

  it('keeps a checkbox link that points somewhere other than a workflow note', () => {
    const readme = readmeWith([entry('001_WD010_Design', 'Design'), '- [x] [protocol](./protocol.md)']);
    expect(insertWorkflowChecklistEntries(readme, [assay])).toContain('- [x] [protocol](./protocol.md)');
  });

  it('keeps prose and the instruction blockquote', () => {
    const readme = readmeWith([
      '> 워크플로를 추가하려면 명령 팔레트를 사용하세요.',
      '',
      entry('001_WD010_Design', 'Design'),
      '',
      '재현성 관련 메모는 아래 Notes 절에 적었습니다.',
    ]);

    const updated = insertWorkflowChecklistEntries(readme, [assay]);

    expect(updated).toContain('> 워크플로를 추가하려면 명령 팔레트를 사용하세요.');
    expect(updated).toContain('재현성 관련 메모는 아래 Notes 절에 적었습니다.');
  });

  it('leaves a to-do between entries where it was when an entry moves (#290)', () => {
    const readme = readmeWith([
      entry('002_WD010_Second', 'Second'),
      '- [ ] 손으로 적은 할 일',
      entry('001_WD010_First', 'First'),
    ]);

    const { content } = reconcileWorkflowChecklist(
      readme,
      [{ from: '001_WD010_First.labnote.md', to: '003_WD010_First.labnote.md' }],
      { move: true }
    );

    expect(content).toBe(
      readmeWith([entry('002_WD010_Second', 'Second'), '- [ ] 손으로 적은 할 일', entry('003_WD010_First', 'First')])
    );
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

    const updated = insertWorkflowChecklistEntries(readme, [assay]);

    expect(updated).toContain('- [ ] [Other](./999_WD999_Other.labnote.md)');
    expect(updated).toContain(entry('001_WD010_Design', 'Design') + '\n' + entry('002_WS010_Assay', 'Assay'));
  });

  it('inserts after the blockquote when the section has no entries yet', () => {
    const readme = readmeWith(['> 지침 문구']);

    const updated = insertWorkflowChecklistEntries(readme, [
      { done: false, title: 'Design', fileName: '001_WD010_Design.labnote.md' },
    ]);

    const lines = updated.split('\n');
    const quote = lines.findIndex(l => l.startsWith('> '));
    const inserted = lines.findIndex(l => l.includes('001_WD010_Design'));
    expect(inserted).toBeGreaterThan(quote);
    expect(lines[inserted - 1].trim()).toBe('');
  });
});

describe('checklist lines are edited in place (#293, #290)', () => {
  const A = '001_WD010_A.labnote.md';
  const B = '002_WB030_B.labnote.md';
  const C = '003_WT020_C.labnote.md';

  it('reads entries with any list marker, indent and a tail', () => {
    const readme = readmeWith([
      `* [ ] [A](./${A}) @issue;LN-x;확인 필요`,
      `  + [x] [B](./${B}) 메모`,
      `[ ] [C](${C})`,
    ]);
    expect(parseWorkflowChecklistFromReadme(readme)).toEqual([
      { done: false, title: 'A', fileName: A },
      { done: true, title: 'B', fileName: B },
      { done: false, title: 'C', fileName: C },
    ]);
  });

  it('keeps the tail, marker and indent of a relinked and relabelled entry', () => {
    const readme = readmeWith([`  * [x] [WD010 A](./${A}) @issue;LN-x;확인 필요`]);
    const res = reconcileWorkflowChecklist(readme, [{ from: A, to: '004_WD010_A.labnote.md' }], {
      labelFor: () => 'WD010 A 2차',
    });
    expect(res.content).toBe(readmeWith(['  * [x] [WD010 A 2차](./004_WD010_A.labnote.md) @issue;LN-x;확인 필요']));
  });

  it('keeps the tail when a label is replaced or an entry removed', () => {
    const readme = readmeWith([`- [ ] [Old](./${A}) 메모`, `- [ ] [B](./${B}) 남김`]);
    expect(relabelWorkflowChecklistEntries(readme, [{ fileName: A, from: 'Old', to: 'New' }])).toBe(
      readmeWith([`- [ ] [New](./${A}) 메모`, `- [ ] [B](./${B}) 남김`])
    );
    expect(removeWorkflowChecklistEntries(readme, [A])).toBe(readmeWith([`- [ ] [B](./${B}) 남김`]));
  });

  it('moves an entry together with the lines indented under it', () => {
    const readme = readmeWith([
      `- [ ] [A](./${A})`,
      '    - [ ] A의 하위 할 일',
      '- [ ] 같은 깊이의 할 일',
      `- [ ] [B](./${B})`,
    ]);
    const res = reconcileWorkflowChecklist(readme, [{ from: A, to: '003_WD010_A.labnote.md' }], { move: true });
    expect(res.content).toBe(
      readmeWith([
        '- [ ] 같은 깊이의 할 일',
        `- [ ] [B](./${B})`,
        '- [ ] [A](./003_WD010_A.labnote.md)',
        '    - [ ] A의 하위 할 일',
      ])
    );
  });

  it('leaves an entry that is still in number order where it is', () => {
    const readme = readmeWith([`- [ ] [A](./${A})`, `- [ ] [B](./${B})`, '- [ ] 할 일']);
    const res = reconcileWorkflowChecklist(readme, [{ from: B, to: '006_WB030_B.labnote.md' }], { move: true });
    expect(res.content).toBe(readmeWith([`- [ ] [A](./${A})`, '- [ ] [B](./006_WB030_B.labnote.md)', '- [ ] 할 일']));
  });

  it('inserts a new entry after the last one at or below its number, in the marker style used', () => {
    const readme = readmeWith([`* [ ] [C](./${C})`, `* [ ] [A](./${A})`, '* [ ] 할 일']);
    expect(insertWorkflowChecklistEntries(readme, [{ done: false, title: 'B', fileName: B }])).toBe(
      readmeWith([`* [ ] [C](./${C})`, `* [ ] [A](./${A})`, `* [ ] [B](./${B})`, '* [ ] 할 일'])
    );
    expect(
      insertWorkflowChecklistEntries(readme, [{ done: false, title: 'D', fileName: '004_WD010_D.labnote.md' }])
    ).toBe(readmeWith([`* [ ] [C](./${C})`, `* [ ] [A](./${A})`, '* [ ] [D](./004_WD010_D.labnote.md)', '* [ ] 할 일']));
    expect(
      insertWorkflowChecklistEntries(readme, [{ done: false, title: 'Z', fileName: '000_WD010_Z.labnote.md' }])
    ).toBe(readmeWith(['* [ ] [Z](./000_WD010_Z.labnote.md)', `* [ ] [C](./${C})`, `* [ ] [A](./${A})`, '* [ ] 할 일']));
  });

  it('tells a workflow entry line and gives its label', () => {
    expect(isWorkflowChecklistEntryLine(`- [ ] [WD010 A \\[1\\]](./${A}) 메모`)).toBe(true);
    expect(isWorkflowChecklistEntryLine(`- [ ] @issue;LN-x;[A](./${A})`)).toBe(false);
    expect(workflowChecklistEntryLabel(`- [ ] [WD010 A](./${A})`)).toBe('WD010 A');
    expect(workflowChecklistEntryLabel('- [ ] 할 일')).toBeUndefined();
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

describe('planWorkflowRenumber by checklist order (#289)', () => {
  const A = '001_WD010_A.labnote.md';
  const B = '002_WB030_B.labnote.md';
  const C = '003_WT020_C.labnote.md';

  it('numbers files in the order the checklist lists them', () => {
    const readme = readmeWith([`- [ ] [C](./${C})`, '- [ ] 할 일', `- [ ] [A](./${A})`, `- [ ] [B](./${B})`]);
    const order = workflowChecklistOrder(readme, [A, B, C, 'README.labnote.md']);
    expect(order).toEqual([C, A, B]);
    expect(planWorkflowRenumber([A, B, C], order)).toEqual([
      { from: C, to: '001_WT020_C.labnote.md' },
      { from: A, to: '002_WD010_A.labnote.md' },
      { from: B, to: '003_WB030_B.labnote.md' },
    ]);
  });

  it('plans nothing when the numbers already follow the checklist', () => {
    expect(planWorkflowRenumber([A, B, C], [A, B, C])).toEqual([]);
  });

  it('lists a file once and skips entries without a file', () => {
    const readme = readmeWith([`- [ ] [A](./${A})`, `- [ ] [A again](./${A})`, '- [ ] [Gone](./004_WD010_Gone.labnote.md)']);
    expect(workflowChecklistOrder(readme, [A, B])).toEqual([A]);
  });

  it('puts an unlisted file before the first listed one that sorts after it', () => {
    const moved = '002_WT100_Moved.labnote.md';
    expect(planWorkflowRenumber([A, moved, C], [A, C])).toEqual([]);
    // C (003) is the first listed file after it, even though A comes later.
    expect(planWorkflowRenumber([A, moved, C], [C, A])).toEqual([
      { from: moved, to: '001_WT100_Moved.labnote.md' },
      { from: C, to: '002_WT020_C.labnote.md' },
      { from: A, to: '003_WD010_A.labnote.md' },
    ]);
  });

  it('fixes a number with the wrong number of digits', () => {
    const short = '01_WB030_B.labnote.md';
    expect(isMisnumberedWorkflowFileName(short)).toBe(true);
    expect(isMisnumberedWorkflowFileName(A)).toBe(false);
    expect(isMisnumberedWorkflowFileName('01_notes.labnote.md')).toBe(false);
    expect(planWorkflowRenumber([A, short], [A, short])).toEqual([{ from: short, to: '002_WB030_B.labnote.md' }]);
  });

  it('swaps two files, parking only on a name still taken', () => {
    const renames = planWorkflowRenumber([A, B], [B, A]);
    expect(renames).toEqual([
      { from: B, to: '001_WB030_B.labnote.md' },
      { from: A, to: '002_WD010_A.labnote.md' },
    ]);
    expect(planRenumberMoves(renames, [A, B])).toEqual([
      { from: B, to: '001_WB030_B.labnote.md' },
      { from: A, to: '002_WD010_A.labnote.md' },
    ]);
  });
});

describe('finding the Related Workflows section (#298)', () => {
  const entry = '- [ ] [A](./001_WD010_A.labnote.md)';
  const md = (heading: string) => ['# E', '', heading, '', entry, '', '## Summary and Discussion', ''].join('\n');

  it('matches a translated or decorated heading', () => {
    for (const heading of ['## 관련 워크플로', '## 🗂️ 관련 워크플로 (Related Workflows)', '## related workflows']) {
      expect(hasWorkflowChecklistSection(md(heading))).toBe(true);
      expect(parseWorkflowChecklistFromReadme(md(heading))).toHaveLength(1);
    }
  });

  it('falls back to the first section holding a workflow entry', () => {
    expect(parseWorkflowChecklistFromReadme(md('## 실험 단계'))).toHaveLength(1);
    expect(hasWorkflowChecklistSection(md('## 실험 단계').replace(entry, ''))).toBe(false);
  });
});

describe('workflowNumberClashes (#288)', () => {
  it('lists the files that share a number', () => {
    const names = ['001_WD010_A.labnote.md', '002_WB030_B.labnote.md', '002_WT020_C.labnote.md', 'README.labnote.md'];
    expect(workflowNumberClashes(names)).toEqual(['002_WB030_B.labnote.md', '002_WT020_C.labnote.md']);
    expect(planWorkflowChecklistSync(readmeWith([]), names).numberClashes).toEqual([
      '002_WB030_B.labnote.md',
      '002_WT020_C.labnote.md',
    ]);
    expect(planWorkflowChecklistSync('# no section', names).numberClashes).toHaveLength(2);
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

// #60: exported tables are named after their note.
describe('table CSVs of a workflow note', () => {
  const files = [
    '002_WT020_C.labnote.md',
    '002_WT020_C.labnote_table1.csv',
    '002_WT020_C.labnote_table12.csv',
    '002_WT020_C_2.labnote_table1.csv',
    '002_WT020_C.labnote_table.csv',
    '002_WT020_C.labnote_table1.csv.bak',
  ];

  it('finds only that note\'s _tableN.csv files', () => {
    expect(siblingTableCsvs('002_WT020_C.labnote.md', files)).toEqual([
      '002_WT020_C.labnote_table1.csv',
      '002_WT020_C.labnote_table12.csv',
    ]);
    expect(siblingTableCsvs('002_WT020_(C).labnote.md', ['002_WT020_(C).labnote_table1.csv'])).toHaveLength(1);
  });

  // #74: a re-export leaves the CSVs of removed tables behind.
  it('lists the CSVs numbered above the current table count', () => {
    const more = [...files, '002_WT020_C.labnote_table3.csv', '002_WT020_C.labnote_table2.csv'];
    expect(staleTableCsvs('002_WT020_C.labnote.md', more, 1)).toEqual([
      '002_WT020_C.labnote_table2.csv',
      '002_WT020_C.labnote_table3.csv',
      '002_WT020_C.labnote_table12.csv',
    ]);
    expect(staleTableCsvs('002_WT020_C.labnote.md', more, 12)).toEqual([]);
    expect(staleTableCsvs('002_WT020_C.labnote.md', more, 0)).toHaveLength(4);
  });

  // #374: a rename that found the new CSV name taken leaves the old one behind.
  it('lists the lab note CSVs whose note is gone', () => {
    expect(
      orphanTableCsvs([
        '001_WT110_A.labnote.md',
        '001_WT110_A.labnote_table1.csv',
        '004_WT110_A.labnote_table1.csv',
        '원자료_table1.csv',
        'README.labnote.md',
        'README.labnote_table2.csv',
      ])
    ).toEqual(['004_WT110_A.labnote_table1.csv']);
  });

  it('plans renames that keep the table number', () => {
    expect(planTableCsvMoves('002_WT020_C.labnote.md', '001_WT020_C.labnote.md', files)).toEqual([
      { from: '002_WT020_C.labnote_table1.csv', to: '001_WT020_C.labnote_table1.csv' },
      { from: '002_WT020_C.labnote_table12.csv', to: '001_WT020_C.labnote_table12.csv' },
    ]);
    expect(planTableCsvMoves('002_WT020_C.labnote.md', '001_WT020_C.labnote.md', ['002_WT020_C.labnote_table01.csv'])).toEqual([
      { from: '002_WT020_C.labnote_table01.csv', to: '001_WT020_C.labnote_table01.csv' },
    ]);
  });
});

// #217: `table10` sorted before `table2` by name.
describe('table CSV numbering', () => {
  const note = '002_WT020_C.labnote.md';
  const csv = (n: string) => `002_WT020_C.labnote_table${n}.csv`;

  it('pads the number to the digits of the table count', () => {
    expect(tableCsvName(note, 1, 9)).toBe(csv('1'));
    expect(tableCsvName(note, 1, 11)).toBe(csv('01'));
    expect(tableCsvName(note, 11, 11)).toBe(csv('11'));
    expect(tableCsvName(note, 7, 100)).toBe(csv('007'));
  });

  it('renames the CSVs of a note that now has ten tables or more', () => {
    const files = [note, csv('1'), csv('2'), csv('9'), csv('10')];
    expect(planTableCsvNames(note, files, 11)).toEqual({
      names: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].map(csv),
      renames: [
        { from: csv('1'), to: csv('01') },
        { from: csv('2'), to: csv('02') },
        { from: csv('9'), to: csv('09') },
      ],
      stale: [],
    });
  });

  it('renames back when the note goes below ten tables, and leaves the rest for the trash', () => {
    const files = [csv('01'), csv('02'), csv('10'), csv('11')];
    expect(planTableCsvNames(note, files, 2)).toEqual({
      names: [csv('1'), csv('2')],
      renames: [
        { from: csv('01'), to: csv('1') },
        { from: csv('02'), to: csv('2') },
      ],
      stale: [csv('10'), csv('11')],
    });
  });

  it('does not rename onto an existing file, and offers the old name for the trash instead', () => {
    const files = [csv('1'), csv('01'), csv('2')];
    expect(planTableCsvNames(note, files, 10)).toEqual({
      names: expect.any(Array),
      renames: [{ from: csv('2'), to: csv('02') }],
      stale: [csv('1')],
    });
    expect(staleTableCsvs(note, files, 10)).toEqual([csv('1')]);
  });

  it('changes nothing for a note with nine tables or fewer', () => {
    const files = [csv('1'), csv('2'), csv('3')];
    expect(planTableCsvNames(note, files, 3)).toEqual({ names: files, renames: [], stale: [] });
  });
});

describe('labelMatchesFileName', () => {
  it('compares label and file name through the path sanitizer', () => {
    expect(labelMatchesFileName('WD030 Design', '003_WD030_Design.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WT020 Protein/Enzyme Expression', '002_WT020_ProteinEnzyme_Expression.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WT020 M1 – M8', '002_WT020_M1-M8.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WT020 M1 M8', '002_WT020_M1-M8.labnote.md')).toBe(false);
    expect(labelMatchesFileName('WD030 Design 2차', '003_WD030_Design.labnote.md')).toBe(false);
    expect(labelMatchesFileName('My own label', '003_WD030_Design.labnote.md')).toBe(false);
    expect(labelMatchesFileName('WD030 Design', 'notes.md')).toBe(false);
  });

  // #148, #165: files named under the earlier rules still match.
  it('matches files named before and after the +/- and length rules', () => {
    expect(labelMatchesFileName('WD030 Design IND+', '003_WD030_Design_IND_plus.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WD030 Design IND+', '003_WD030_Design_IND.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WD030 Design IND-', '003_WD030_Design_IND.labnote.md')).toBe(true);
    expect(labelMatchesFileName('WD030 Design IND+', '003_WD030_Design_IND_minus.labnote.md')).toBe(false);
    const long = `WD030 Design ${'가'.repeat(150)}`;
    expect(labelMatchesFileName(long, createWorkflowFileName('003', { id: 'WD030', name: 'Design', description: '' }, '가'.repeat(150)))).toBe(true);
    expect(labelMatchesFileName(long, `003_WD030_Design_${'가'.repeat(150)}.labnote.md`)).toBe(true);
    // Cut at 0.101.0's 100 code points, before the cap went down to 80.
    expect(labelMatchesFileName(long, `003_WD030_Design_${'가'.repeat(87)}.labnote.md`)).toBe(true);
    expect(labelMatchesFileName(`WD030 Design ${'가'.repeat(80)} 나`, `003_WD030_Design_${'가'.repeat(80)}.labnote.md`)).toBe(true);
  });
});

describe('workflowLabelFor', () => {
  const FILE = '002_WT020_ProteinEnzyme_Expression_2차_발현.labnote.md';
  const h2 = '## [WT020 Protein/Enzyme Expression] 2차 발현\n';

  it('takes the front-matter title when it matches the file name', () => {
    const note = `---\ntitle: 'WT020 Protein/Enzyme Expression 2차: 발현'\n---\n\n${h2}`;
    expect(workflowLabelFor(FILE, note)).toBe('WT020 Protein/Enzyme Expression 2차: 발현');
  });

  it('builds catalog name + alias from the heading when the title is stale', () => {
    const note = `---\ntitle: WT020 Protein/Enzyme Expression 1차\n---\n\n${h2}`;
    expect(workflowLabelFor(FILE, note)).toBe('WT020 Protein/Enzyme Expression 2차 발현');
    expect(workflowLabelFor('002_WT020_ProteinEnzyme_Expression.labnote.md', note)).toBe(
      'WT020 Protein/Enzyme Expression'
    );
  });

  it('falls back to the file name without a usable heading', () => {
    expect(workflowLabelFor(FILE, 'no front matter')).toBe('WT020 ProteinEnzyme Expression 2차 발현');
    expect(workflowLabelFor(FILE, '## [WD010 Design]\n')).toBe('WT020 ProteinEnzyme Expression 2차 발현');
    expect(workflowLabelFor(FILE)).toBe('WT020 ProteinEnzyme Expression 2차 발현');
  });
});

describe('rewriteWorkflowTitle', () => {
  const note = [
    '---',
    'title: WT020 Protein/Enzyme Expression 1차',
    'experimenter: Kim',
    '---',
    '',
    '## [WT020 Protein/Enzyme Expression] 1차',
    '',
    '> desc',
    '',
    '### [UHW100 PCR] 1차',
  ].join('\n');

  it('changes only the title line and the workflow heading', () => {
    expect(rewriteWorkflowTitle(note, 'WT020', 'Protein/Enzyme Expression', '2차: 재시도')).toBe(
      note
        .replace('title: WT020 Protein/Enzyme Expression 1차', "title: 'WT020 Protein/Enzyme Expression 2차: 재시도'")
        .replace('## [WT020 Protein/Enzyme Expression] 1차', '## [WT020 Protein/Enzyme Expression] 2차: 재시도')
    );
  });

  it('drops the alias when it is empty', () => {
    const out = rewriteWorkflowTitle(note, 'WT020', 'Protein/Enzyme Expression', ' ');
    expect(out).toContain('\ntitle: WT020 Protein/Enzyme Expression\n');
    expect(out).toContain('\n## [WT020 Protein/Enzyme Expression]\n');
    expect(out).toContain('### [UHW100 PCR] 1차');
    expect(parseWorkflowHeading(out)).toEqual({ id: 'WT020', name: 'Protein/Enzyme Expression', alias: '' });
  });

  it('rewrites only the parts asked for', () => {
    const titleOnly = rewriteWorkflowTitle(note, 'WT020', 'Protein/Enzyme Expression', '2차', { heading: false });
    expect(titleOnly).toContain('\ntitle: WT020 Protein/Enzyme Expression 2차\n');
    expect(titleOnly).toContain('\n## [WT020 Protein/Enzyme Expression] 1차\n');
    const headingOnly = rewriteWorkflowTitle(note, 'WT020', 'Protein/Enzyme Expression', '2차', { title: false });
    expect(headingOnly).toContain('\ntitle: WT020 Protein/Enzyme Expression 1차\n');
    expect(headingOnly).toContain('\n## [WT020 Protein/Enzyme Expression] 2차\n');
  });
});

describe('workflowAliasFromFileName', () => {
  const heading = { id: 'WT020', name: 'Protein/Enzyme Expression', alias: '1차' };

  it('reads the alias after the catalog name, _ as spaces', () => {
    expect(workflowAliasFromFileName('002_WT020_ProteinEnzyme_Expression_2차_발현.labnote.md', heading)).toBe(
      '2차 발현'
    );
    expect(workflowAliasFromFileName('002_WT020_ProteinEnzyme_Expression.labnote.md', heading)).toBe('');
  });

  it('is undefined when the ID or the catalog-name part changed', () => {
    expect(workflowAliasFromFileName('002_WT030_ProteinEnzyme_Expression_2차.labnote.md', heading)).toBeUndefined();
    expect(workflowAliasFromFileName('002_WT020_Protein_Assay_2차.labnote.md', heading)).toBeUndefined();
    expect(workflowAliasFromFileName('notes.md', heading)).toBeUndefined();
  });
});

describe('planWorkflowRetitle (#71)', () => {
  const OLD = '001_WB120_Biology-mediated_DNA_Transfers_열충격.labnote.md';
  const NEW = '001_WB120_Biology-mediated_DNA_Transfers_전기천공.labnote.md';
  const note = (title: string, alias: string) =>
    ['---', `title: ${title}`, '---', '', `## [WB120 Biology-mediated DNA Transfers] ${alias}`, '', '본문'].join('\n');
  const ORIGINAL = note('WB120 Biology-mediated DNA Transfers 열충격', '열충격');

  it('follows an alias change made by renaming the file', () => {
    expect(planWorkflowRetitle(ORIGINAL, NEW, OLD)).toEqual({
      from: 'WB120 Biology-mediated DNA Transfers 열충격',
      to: 'WB120 Biology-mediated DNA Transfers 전기천공',
      content: note('WB120 Biology-mediated DNA Transfers 전기천공', '전기천공'),
    });
  });

  it('reads _ in the new alias as spaces and drops a removed alias', () => {
    const out = planWorkflowRetitle(ORIGINAL, '001_WB120_Biology-mediated_DNA_Transfers_M9_최소배지.labnote.md', OLD);
    expect(out?.to).toBe('WB120 Biology-mediated DNA Transfers M9 최소배지');
    const bare = planWorkflowRetitle(ORIGINAL, '001_WB120_Biology-mediated_DNA_Transfers.labnote.md', OLD);
    expect(bare?.content).toContain('\ntitle: WB120 Biology-mediated DNA Transfers\n');
    expect(bare?.content).toContain('\n## [WB120 Biology-mediated DNA Transfers]\n');
  });

  it('changes nothing when only the number changed, keeping the punctuation', () => {
    const typed = note('WB120 Biology-mediated DNA Transfers LB_기본 (v2)', 'LB_기본 (v2)');
    expect(
      planWorkflowRetitle(
        typed,
        '002_WB120_Biology-mediated_DNA_Transfers_LB_기본_v2.labnote.md',
        '001_WB120_Biology-mediated_DNA_Transfers_LB_기본_v2.labnote.md'
      )
    ).toBeUndefined();
  });

  it('keeps a title edited by hand', () => {
    expect(planWorkflowRetitle(note('My own title', '열충격'), NEW, OLD)).toBeUndefined();
  });

  // #268: the ID in the file name was changed by hand and the offer to put it
  // back declined, so the old name and the title name different IDs.
  it('follows an alias change after the file ID was changed and not put back', () => {
    const out = planWorkflowRetitle(
      ORIGINAL,
      '001_WB120_Biology-mediated_DNA_Transfers_열충격2.labnote.md',
      '001_WB130_Biology-mediated_DNA_Transfers_열충격.labnote.md'
    );
    expect(out?.to).toBe('WB120 Biology-mediated DNA Transfers 열충격2');
    expect(out?.content).toContain('\ntitle: WB120 Biology-mediated DNA Transfers 열충격2\n');
    expect(out?.content).toContain('\n## [WB120 Biology-mediated DNA Transfers] 열충격2\n');
  });

  it('still keeps a hand-edited title when the old name had another ID', () => {
    expect(
      planWorkflowRetitle(
        note('My own title', '열충격'),
        '001_WB120_Biology-mediated_DNA_Transfers_열충격2.labnote.md',
        '001_WB130_Biology-mediated_DNA_Transfers_열충격.labnote.md'
      )
    ).toBeUndefined();
  });

  // #165: a file named before `IND+` became `IND_plus` keeps its title.
  it('changes nothing for a file named under the earlier +/- rule', () => {
    const typed = note('WB120 Biology-mediated DNA Transfers IND+', 'IND+');
    expect(
      planWorkflowRetitle(
        typed,
        '002_WB120_Biology-mediated_DNA_Transfers_IND.labnote.md',
        '001_WB120_Biology-mediated_DNA_Transfers_IND.labnote.md'
      )
    ).toBeUndefined();
  });

  it('keeps a heading edited by hand while following the title', () => {
    const out = planWorkflowRetitle(note('WB120 Biology-mediated DNA Transfers 열충격', '내 제목'), NEW, OLD);
    expect(out?.content).toContain('\ntitle: WB120 Biology-mediated DNA Transfers 전기천공\n');
    expect(out?.content).toContain('\n## [WB120 Biology-mediated DNA Transfers] 내 제목\n');
  });

  it('uses the heading for a note without a title', () => {
    const noTitle = '## [WB120 Biology-mediated DNA Transfers] 열충격\n';
    expect(planWorkflowRetitle(noTitle, NEW, OLD)).toEqual({
      from: 'WB120 Biology-mediated DNA Transfers 열충격',
      to: 'WB120 Biology-mediated DNA Transfers 전기천공',
      content: '## [WB120 Biology-mediated DNA Transfers] 전기천공\n',
    });
  });

  it('keeps catalog punctuation in the rewritten title', () => {
    const wt = ['---', 'title: WT020 Protein/Enzyme Expression 1차', '---', '', '## [WT020 Protein/Enzyme Expression] 1차'].join(
      '\n'
    );
    expect(
      planWorkflowRetitle(
        wt,
        '002_WT020_ProteinEnzyme_Expression_2차.labnote.md',
        '002_WT020_ProteinEnzyme_Expression_1차.labnote.md'
      )?.to
    ).toBe('WT020 Protein/Enzyme Expression 2차');
  });

  it('changes nothing when the ID or catalog-name part changed, or without a heading', () => {
    expect(planWorkflowRetitle(ORIGINAL, '001_WB130_Biology-mediated_DNA_Transfers_전기천공.labnote.md', OLD)).toBeUndefined();
    expect(planWorkflowRetitle(ORIGINAL, '001_WB120_Plasmid_Prep_전기천공.labnote.md', OLD)).toBeUndefined();
    expect(planWorkflowRetitle('---\ntitle: WB120 X 열충격\n---\n', NEW, OLD)).toBeUndefined();
  });

  it('without an old name, fixes any part that does not match the file', () => {
    expect(planWorkflowRetitle(ORIGINAL, NEW)?.to).toBe('WB120 Biology-mediated DNA Transfers 전기천공');
    expect(planWorkflowRetitle(note('My own title', '열충격'), NEW)?.from).toBe('My own title');
    expect(planWorkflowRetitle(ORIGINAL, OLD)).toBeUndefined();
  });

  // #194: a copy renamed by hand kept the original's title and heading.
  it('retitles a copy renamed by hand, with the alias as the file name spells it', () => {
    const copy = [
      '---',
      'title: WT100 Micro-scale Parallel Cell Culture 톨루엔 계대 L1-L6',
      '---',
      '',
      '## [WT100 Micro-scale Parallel Cell Culture] 톨루엔 계대 L1-L6',
    ].join('\n');
    const out = planWorkflowRetitle(copy, '003_WT100_Micro-scale_Parallel_Cell_Culture_L1-L5_0.1%p.labnote.md');
    expect(out?.to).toBe('WT100 Micro-scale Parallel Cell Culture L1-L5 0.1%p');
    expect(out?.content).toContain('\n## [WT100 Micro-scale Parallel Cell Culture] L1-L5 0.1%p');
    // A file name cannot hold `/`, so an alias typed with one comes back without it.
    const slash = planWorkflowRetitle(copy, '003_WT100_Micro-scale_Parallel_Cell_Culture_L1_L5.labnote.md');
    expect(slash?.to).toBe('WT100 Micro-scale Parallel Cell Culture L1 L5');
  });
});

describe('workflowIdMismatch (#240)', () => {
  const note = ['---', 'title: WD010 Design 성장곡선', '---', '', '## [WD010 Design] 성장곡선', ''].join('\r\n');

  it('reports the file and note IDs when a rename changed the catalog ID', () => {
    expect(planWorkflowRetitle(note, '001_WT030_Design_성장곡선.labnote.md')).toBeUndefined();
    expect(workflowIdMismatch('001_WT030_Design_성장곡선.labnote.md', note)).toEqual({
      fileId: 'WT030',
      noteId: 'WD010',
    });
  });

  it('is undefined when the IDs agree or either side is not a workflow', () => {
    expect(workflowIdMismatch('002_WD010_Design_성장곡선.labnote.md', note)).toBeUndefined();
    expect(workflowIdMismatch('notes.md', note)).toBeUndefined();
    expect(workflowIdMismatch('001_WT030_Design.labnote.md', '본문만 있음')).toBeUndefined();
  });
});

// #68: labels followed only the first registration.
describe('reconcileWorkflowChecklist with labelFor', () => {
  const OLD = '002_WD030_Design.labnote.md';
  const NEW = '002_WD030_Design_2차.labnote.md';
  const labelFor = (name: string) => (name === NEW ? 'WD030 Design 2차' : defaultWorkflowTitle(name));
  const labels = (md: string) => parseWorkflowChecklistFromReadme(md).map(i => `${i.title}:${i.fileName}`);

  it('relabels an entry whose label matched the old name, whether or not the link was updated', () => {
    for (const link of [`./${OLD}`, NEW]) {
      const res = reconcileWorkflowChecklist(readmeWith([`- [ ] [WD030 Design](${link})`]), [{ from: OLD, to: NEW }], {
        labelFor,
      });
      expect(labels(res.content)).toEqual([`WD030 Design 2차:${NEW}`]);
    }
  });

  it('keeps a label written by hand', () => {
    const res = reconcileWorkflowChecklist(readmeWith([`- [ ] [디자인 첫 실험](./${OLD})`]), [{ from: OLD, to: NEW }], {
      labelFor,
    });
    expect(labels(res.content)).toEqual([`디자인 첫 실험:${NEW}`]);
  });

  it('leaves labels alone without labelFor', () => {
    const res = reconcileWorkflowChecklist(readmeWith([`- [ ] [WD030 Design](./${OLD})`]), [{ from: OLD, to: NEW }]);
    expect(labels(res.content)).toEqual([`WD030 Design:${NEW}`]);
  });
});

describe('planWorkflowChecklistSync relabel', () => {
  const md = readmeWith([
    '- [ ] [WD030 Design](./002_WD030_Design_2차.labnote.md)',
    '- [ ] [WT020 ProteinEnzyme Expression](./003_WT020_ProteinEnzyme_Expression.labnote.md)',
  ]);
  const names = ['002_WD030_Design_2차.labnote.md', '003_WT020_ProteinEnzyme_Expression.labnote.md'];
  const titles = new Map([
    ['002_WD030_Design_2차.labnote.md', 'WD030 Design 2차'],
    ['003_WT020_ProteinEnzyme_Expression.labnote.md', 'WT020 Protein/Enzyme Expression'],
  ]);

  it('reports labels that do not match their file, without changing content', () => {
    const plan = planWorkflowChecklistSync(md, names, titles);
    expect(plan.relabel).toEqual([
      { fileName: '002_WD030_Design_2차.labnote.md', from: 'WD030 Design', to: 'WD030 Design 2차' },
    ]);
    expect(plan.content).toBe(md);
  });

  it('applies the relabels to matching entries only', () => {
    const out = relabelWorkflowChecklistEntries(md, planWorkflowChecklistSync(md, names, titles).relabel);
    expect(out).toBe(md.replace('[WD030 Design](', '[WD030 Design 2차]('));
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

  it('leaves out characters no link can reach (#326)', () => {
    expect(suggestWorkflowFileName('001_WB030_Gibson.labnote #2.md')).toBe('001_WB030_Gibson 2.labnote.md');
  });
});

describe('rebuildExperimentReadme (#340)', () => {
  it('titles the README from the folder and lists the workflow notes by number', () => {
    const md = rebuildExperimentReadme(
      '003_효모_삽입',
      ['002_WB030_B.labnote.md', 'README.md', '001_WD010_A.labnote.md', 'images'],
      new Map([['001_WD010_A.labnote.md', 'WD010 A 설계']]),
      '김연구'
    );
    expect(md).toMatch(/^---\ntitle: 효모 삽입\nauthor: 김연구\n/);
    expect(md).toContain('status: planned');
    const entries = md.split('\n').filter(l => l.startsWith('- ['));
    expect(entries).toEqual(['- [ ] [WD010 A 설계](./001_WD010_A.labnote.md)', '- [ ] [WB030 B](./002_WB030_B.labnote.md)']);
  });
});

describe('unlinkableNameChars / suggestLinkableFileName (#326)', () => {
  it('finds the link-syntax characters of a name', () => {
    expect(unlinkableNameChars('002_WB030_A#1_[재]|x^.labnote.md')).toEqual(['#', '[', ']', '|', '^']);
    expect(unlinkableNameChars('002_WB030_재조립 (2).labnote.md')).toEqual([]);
  });

  it('suggests the name without them, tidying underscores', () => {
    expect(suggestLinkableFileName('002_WB030_A_#1.labnote.md')).toBe('002_WB030_A_1.labnote.md');
    expect(suggestLinkableFileName('002_WB030_A_#.labnote.md')).toBe('002_WB030_A.labnote.md');
    expect(suggestLinkableFileName('002_WB030_[재]_조립.labnote.md')).toBe('002_WB030_재_조립.labnote.md');
    expect(suggestLinkableFileName('002_WB030_A.labnote.md')).toBeUndefined();
  });

  it('flags such workflow files in the checklist sync plan', () => {
    const plan = planWorkflowChecklistSync(readmeWith([]), ['001_WD010_A.labnote.md', '002_WB030_A#1.labnote.md']);
    expect(plan.unlinkable).toEqual(['002_WB030_A#1.labnote.md']);
  });
});

// #56/#52/#44: workflow files already in the folder must be registrable.
describe('planWorkflowChecklistSync', () => {
  const readme = (entries: string[]) =>
    [
      '---',
      'title: X',
      '---',
      '',
      '## 🗂️ Related Workflows',
      '',
      '> Run `Create workflow`.',
      '',
      ...entries,
      '',
      '## Notes',
      '',
      '- [ ] ask Dr. Kim',
      '',
    ].join('\n');

  it('adds unlisted workflow files in NNN order and leaves other lines alone', () => {
    const md = readme(['- [x] [WD030 Design](./002_WD030_Design.labnote.md)']);
    const plan = planWorkflowChecklistSync(
      md,
      ['README.labnote.md', '001_WT100_Seq.labnote.md', '002_WD030_Design.labnote.md', 'images'],
      new Map([['001_WT100_Seq.labnote.md', 'WT100 Seq moved']])
    );
    expect(plan.hasSection).toBe(true);
    expect(plan.added.map(a => a.fileName)).toEqual(['001_WT100_Seq.labnote.md']);
    expect(plan.stale).toEqual([]);
    expect(parseWorkflowChecklistFromReadme(plan.content)).toEqual([
      { done: false, title: 'WT100 Seq moved', fileName: '001_WT100_Seq.labnote.md' },
      { done: true, title: 'WD030 Design', fileName: '002_WD030_Design.labnote.md' },
    ]);
    expect(plan.content).toContain('- [ ] ask Dr. Kim');
    expect(plan.content).toContain('> Run `Create workflow`.');
  });

  it('falls back to a title built from the file name', () => {
    expect(defaultWorkflowTitle('003_WT020_Protein_Expression.labnote.md')).toBe('WT020 Protein Expression');
    const plan = planWorkflowChecklistSync(readme([]), ['003_WT020_Protein_Expression.labnote.md']);
    expect(plan.added[0].title).toBe('WT020 Protein Expression');
    expect(plan.content).toContain('- [ ] [WT020 Protein Expression](./003_WT020_Protein_Expression.labnote.md)');
  });

  it('reports missing and moved-away entries without removing them', () => {
    const md = readme([
      '- [ ] [A](./001_WD010_A.labnote.md)',
      '- [ ] [Gone](./002_WD020_Gone.labnote.md)',
      '- [ ] [Moved](../002_B/001_WT030_Moved.labnote.md)',
    ]);
    const plan = planWorkflowChecklistSync(md, ['001_WD010_A.labnote.md', '001_WT030_Moved.labnote.md']);
    expect(plan.stale).toEqual([
      { link: '002_WD020_Gone.labnote.md', title: 'Gone', reason: 'missing' },
      { link: '../002_B/001_WT030_Moved.labnote.md', title: 'Moved', reason: 'elsewhere' },
    ]);
    // A same-named file in this folder is not taken as already listed by the `../` link.
    expect(plan.added.map(a => a.fileName)).toEqual(['001_WT030_Moved.labnote.md']);
  });

  // #94
  it('tells a note moved into a subfolder of this experiment from a missing or moved-away one', () => {
    const dir = 'labnote/001_A';
    const md = readme([
      '- [ ] [Name only](./003_WD040_Assay.labnote.md)',
      '- [ ] [Relative](images/004_WD050_Scan.labnote.md)',
      '- [ ] [Absolute](labnote/001_A/images/005_WD060_Gel.labnote.md)',
      '- [ ] [Other](../002_B/images/004_WD050_Scan.labnote.md)',
      '- [ ] [Gone](./006_WD070_Gone.labnote.md)',
    ]);
    const files = new Map([
      ['003_WD040_Assay.labnote.md', ['images/003_WD040_Assay.labnote.md']],
      ['004_WD050_Scan.labnote.md', ['images/004_WD050_Scan.labnote.md']],
      ['005_WD060_Gel.labnote.md', ['images/005_WD060_Gel.labnote.md']],
    ]);
    const plan = planWorkflowChecklistSync(md, [], new Map(), { dir, files });
    expect(plan.stale.map(s => [s.link, s.reason, s.found])).toEqual([
      ['003_WD040_Assay.labnote.md', 'subfolder', ['images/003_WD040_Assay.labnote.md']],
      ['images/004_WD050_Scan.labnote.md', 'subfolder', ['images/004_WD050_Scan.labnote.md']],
      ['labnote/001_A/images/005_WD060_Gel.labnote.md', 'subfolder', ['images/005_WD060_Gel.labnote.md']],
      ['../002_B/images/004_WD050_Scan.labnote.md', 'elsewhere', undefined],
      ['006_WD070_Gone.labnote.md', 'missing', undefined],
    ]);
  });

  it('relinks a moved-back entry to ./name, keeping checkbox and label', () => {
    const md = readme(['- [x] [WD050 \\[Scan\\]](images/004_WD050_Scan.labnote.md)']);
    expect(
      relinkWorkflowChecklistEntries(md, [{ from: 'images/004_WD050_Scan.labnote.md', to: '004_WD050_Scan.labnote.md' }])
    ).toContain('- [x] [WD050 \\[Scan\\]](./004_WD050_Scan.labnote.md)');
  });

  it('points a copied experiment back at its own notes (#320)', () => {
    const md = readme([
      '- [x] [WD010 A](labnote/002_X/001_WD010_A.labnote.md) @issue;ISS-1;확인',
      '  - [ ] [WD020 B](../002_X/002_WD020_B.labnote.md)',
      '- [ ] [WD030 C](./003_WD030_C.labnote.md)',
      '- [ ] [WD040 D](labnote/002_X/004_WD040_D.labnote.md)',
      '- [ ] [Old](archive/005_WD050_E.labnote.md)',
    ]);
    const names = ['001_WD010_A.labnote.md', '002_WD020_B.labnote.md', '003_WD030_C.labnote.md', 'README.labnote.md'];
    const out = relinkCopiedExperimentChecklist(md, 'labnote/005_Y', names);
    expect(out.count).toBe(2);
    expect(out.content).toContain('- [x] [WD010 A](./001_WD010_A.labnote.md) @issue;ISS-1;확인');
    expect(out.content).toContain('  - [ ] [WD020 B](./002_WD020_B.labnote.md)');
    expect(out.content).toContain('- [ ] [WD040 D](labnote/002_X/004_WD040_D.labnote.md)');
    expect(out.content).toContain('- [ ] [Old](archive/005_WD050_E.labnote.md)');
    expect(relinkCopiedExperimentChecklist(out.content, 'labnote/005_Y', names)).toEqual({ content: out.content, count: 0 });
  });

  it('decodes escaped links before comparing', () => {
    const md = readme(['- [ ] [A](./001_WD010_%EC%8B%A4%ED%97%98.labnote.md)']);
    const plan = planWorkflowChecklistSync(md, ['001_WD010_실험.labnote.md']);
    expect(plan.added).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('changes nothing when nothing is added', () => {
    const md = readme(['- [ ] [B](./002_WD020_B.labnote.md)', '- [ ] [A](./001_WD010_A.labnote.md)']);
    const plan = planWorkflowChecklistSync(md, ['001_WD010_A.labnote.md', '002_WD020_B.labnote.md']);
    expect(plan.content).toBe(md);
  });

  it('reports a missing section instead of adding', () => {
    const plan = planWorkflowChecklistSync('# README\n', ['001_WD010_A.labnote.md']);
    expect(plan.hasSection).toBe(false);
    expect(plan.added).toEqual([]);
    expect(plan.content).toBe('# README\n');
  });
});

describe('removeWorkflowChecklistEntries', () => {
  it('removes only entries whose link matches exactly', () => {
    const md = [
      '## Related Workflows',
      '- [ ] [Here](./001_WT030_X.labnote.md)',
      '- [ ] [There](../002_B/001_WT030_X.labnote.md)',
      '',
      '## Other',
      '- [ ] [There](../002_B/001_WT030_X.labnote.md)',
    ].join('\n');
    const out = removeWorkflowChecklistEntries(md, ['../002_B/001_WT030_X.labnote.md']);
    expect(out).toBe(
      [
        '## Related Workflows',
        '- [ ] [Here](./001_WT030_X.labnote.md)',
        '',
        '## Other',
        '- [ ] [There](../002_B/001_WT030_X.labnote.md)',
      ].join('\n')
    );
  });

  it('matches a %20 link by its file name (#412)', () => {
    const md = ['## Related Workflows', '- [ ] [A B](./001_WT030_A%20B.labnote.md)', '- [ ] [C](./002_WT030_C.labnote.md)'].join('\n');
    expect(removeWorkflowChecklistEntries(md, ['001_WT030_A B.labnote.md'])).toBe(
      ['## Related Workflows', '- [ ] [C](./002_WT030_C.labnote.md)'].join('\n')
    );
  });
});

describe('relinkWorkflowChecklistEntries with a %20 link (#412)', () => {
  it('relinks the entry written with %20 when given the decoded name', () => {
    const md = ['## Related Workflows', '- [x] [A B](sub/001_WT030_A%20B.labnote.md)'].join('\n');
    expect(
      relinkWorkflowChecklistEntries(md, [{ from: 'sub/001_WT030_A B.labnote.md', to: '001_WT030_A B.labnote.md' }])
    ).toBe(['## Related Workflows', '- [x] [A B](./001_WT030_A%20B.labnote.md)'].join('\n'));
  });
});

// #95: an alias with brackets must not break the checklist line.
describe('checklist labels with brackets', () => {
  const md = (entries: string[]) => ['## Related Workflows', '', ...entries, '', '## Notes', ''].join('\n');
  const A = '001_WB045_DNA_Extraction_재_겨울_추출.labnote.md';
  const B = '002_WD010_Design_LOC-01.labnote.md';

  it('escapes brackets and backslashes when writing, and reads the label back', () => {
    const items = [
      { done: false, title: 'WB045 DNA Extraction [재] 겨울 추출', fileName: A },
      { done: true, title: 'WD010 Design LOC-01]', fileName: B },
      { done: false, title: 'WD020 Path C:\\', fileName: '003_WD020_Path_C.labnote.md' },
    ];
    const out = generateWorkflowChecklist(items);
    expect(out.split('\n')).toEqual([
      `- [ ] [WB045 DNA Extraction \\[재\\] 겨울 추출](./${A})`,
      `- [x] [WD010 Design LOC-01\\]](./${B})`,
      '- [ ] [WD020 Path C:\\\\](./003_WD020_Path_C.labnote.md)',
    ]);
    expect(parseWorkflowChecklistFromReadme(md([out]))).toEqual(items);
  });

  it('reads entries written before 0.96.0 with unescaped brackets', () => {
    const readme = md([`- [ ] [WB045 DNA Extraction [재] 겨울 추출](./${A})`, `- [ ] [WD010 Design LOC-01]](./${B})`]);
    expect(parseWorkflowChecklistFromReadme(readme).map(i => `${i.title}:${i.fileName}`)).toEqual([
      `WB045 DNA Extraction [재] 겨울 추출:${A}`,
      `WD010 Design LOC-01]:${B}`,
    ]);
  });

  it('adds nothing for a listed bracketed entry, so a second sync stays quiet', () => {
    const readme = md([`- [ ] [WD010 Design LOC-01]](./${B})`]);
    const plan = planWorkflowChecklistSync(readme, [B], new Map([[B, 'WD010 Design LOC-01]']]));
    expect(plan.added).toEqual([]);
    expect(plan.relabel).toEqual([]);
    expect(plan.unescaped).toEqual(['WD010 Design LOC-01]']);
    const fixed = normalizeWorkflowChecklistLabels(readme);
    expect(fixed).toContain(`- [ ] [WD010 Design LOC-01\\]](./${B})`);
    const again = planWorkflowChecklistSync(fixed, [B], new Map([[B, 'WD010 Design LOC-01]']]));
    expect(again.added).toEqual([]);
    expect(again.unescaped).toEqual([]);
    expect(again.duplicates).toEqual([]);
  });

  it('reports and removes duplicates of files in the folder, keeping a check', () => {
    const readme = md([
      `- [ ] [WD010 Design LOC-01]](./${B})`,
      '- [ ] [Gone](./004_WD040_Gone.labnote.md)',
      `- [x] [WD010 Design LOC-01\\]](./${B})`,
      '- [ ] [Gone](./004_WD040_Gone.labnote.md)',
      `- [ ] [WD010 Design LOC-01\\]](./${B})`,
    ]);
    const plan = planWorkflowChecklistSync(readme, [B]);
    expect(plan.duplicates).toEqual([B, B]);
    expect(dedupeWorkflowChecklistEntries(readme, [B])).toBe(
      md([`- [x] [WD010 Design LOC-01]](./${B})`, '- [ ] [Gone](./004_WD040_Gone.labnote.md)', '- [ ] [Gone](./004_WD040_Gone.labnote.md)'])
    );
  });

  it('relabels an entry whose stored label is escaped', () => {
    const readme = md([`- [ ] [WD010 Design LOC-01\\]](./${B})`]);
    const out = relabelWorkflowChecklistEntries(readme, [
      { fileName: B, from: 'WD010 Design LOC-01]', to: 'WD010 Design [LOC-02]' },
    ]);
    expect(out).toContain(`- [ ] [WD010 Design \\[LOC-02\\]](./${B})`);
  });
});

describe('copied workflow names', () => {
  it('recognises Obsidian and file-manager copies only', () => {
    expect(isCopiedWorkflowFileName('001_WT020_X.labnote 1.md')).toBe(true);
    expect(isCopiedWorkflowFileName('001_WT020_X.labnote - 복사본.md')).toBe(true);
    expect(isCopiedWorkflowFileName('001_WT020_X.labnote.md')).toBe(false);
    expect(isCopiedWorkflowFileName('WT020_X.labnote 1.md')).toBe(false);
    expect(isCopiedWorkflowFileName('001_WT020_X 1.md')).toBe(false);
  });

  it('suggests the next free number instead of a duplicate one', () => {
    const existing = ['001_WT020_X.labnote.md', '002_WD010_Y.labnote.md', '001_WT020_X.labnote 1.md'];
    expect(suggestCopiedWorkflowFileName('001_WT020_X.labnote 1.md', existing)).toBe('003_WT020_X.labnote.md');
  });

  it('does not guess for a non-standard stem', () => {
    expect(suggestCopiedWorkflowFileName('001_notes.labnote 1.md', [])).toBeUndefined();
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

  // #94
  it('reports a move into a subfolder or out of the experiment, not to another one or the trash', () => {
    expect(classifyWorkflowMoveOut(valid, `${dir}/images/001_WB030_Gibson.labnote.md`)).toEqual({
      dir,
      location: 'images/',
    });
    expect(classifyWorkflowMoveOut(valid, 'archive/old/001_WB030_Gibson.labnote.md')).toEqual({
      dir,
      location: 'archive/old/',
    });
    expect(classifyWorkflowMoveOut(valid, '001_WB030_Gibson.labnote.md')).toEqual({ dir, location: '/' });
    expect(classifyWorkflowMoveOut(valid, '.trash/001_WB030_Gibson.labnote.md')).toBeNull();
    expect(classifyWorkflowMoveOut(valid, 'labnote/002_Other/001_WB030_Gibson.labnote.md')).toBeNull();
    expect(classifyWorkflowMoveOut(valid, broken)).toBeNull();
    expect(classifyWorkflowMoveOut(`${dir}/images/001_WB030_Gibson.labnote.md`, `${dir}/x/001_WB030_Gibson.labnote.md`)).toBeNull();
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

  // #49: a decimal point between digits keeps its meaning.
  it('keeps a decimal point between digits', () => {
    expect(sanitizeTitle('OD600 0.4~0.8 구간 수확')).toBe('OD600_0.4-0.8_구간_수확');
    expect(sanitizeTitle('37.5°C 배양')).toBe('37.5C_배양');
    expect(sanitizeTitle('-0.5 mM')).toBe('-0.5_mM');
    expect(sanitizeWorkflowName('Pipeline v1.2.3')).toBe('Pipeline_v1.2.3');
    expect(sanitizeTitle('0.5. 다음')).toBe('0.5_다음');
    expect(sanitizeTitle('.5 단계.')).toBe('5_단계');
  });

  it('turns a slash or colon between digits into `_` so numbers never fuse', () => {
    expect(sanitizeTitle('pH 7.0/8.0 비교')).toBe('pH_7.0_8.0_비교');
    expect(sanitizeTitle('희석 1.5:2.5')).toBe('희석_1.5_2.5');
    expect(sanitizeTitle('1:10 희석')).toBe('1_10_희석');
    expect(sanitizeTitle('pH 7/8')).toBe('pH_7_8');
    expect(sanitizeTitle('2026/10/13 실험')).toBe('2026_10_13_실험');
    expect(sanitizeTitle('1 / 2')).toBe('1_2');
    expect(sanitizeTitle('비율 1／2')).toBe('비율_1_2');
  });

  // #59: the same rule for every other symbol between digits.
  it('never fuses numbers around ×, commas, ± or other symbols', () => {
    expect(sanitizeTitle('3×2 요인 설계')).toBe('3x2_요인_설계');
    expect(sanitizeTitle('3 × 2')).toBe('3x2');
    expect(sanitizeTitle('3×−2')).toBe('3x-2');
    expect(sanitizeTitle('RNA-seq 전사체 분석 (3 조건 × 2 반복)')).toBe('RNA-seq_전사체_분석_3_조건_2_반복');
    expect(sanitizeTitle('1,000배 희석과 5±1도')).toBe('1000배_희석과_5_1도');
    expect(sanitizeTitle('배지 3×3 교차 2,500 rpm 37±2')).toBe('배지_3x3_교차_2500_rpm_37_2');
    expect(sanitizeTitle('OD 0,4 유럽식 표기')).toBe('OD_0_4_유럽식_표기');
    expect(sanitizeTitle('1,000,000')).toBe('1000000');
    expect(sanitizeTitle('1,000.5')).toBe('1000.5');
    expect(sanitizeTitle('5%/10%')).toBe('5_10');
    expect(sanitizeTitle('96x8 플레이트 배치')).toBe('96x8_플레이트_배치');
  });

  it('still drops a slash, colon or × that is not between digits', () => {
    expect(sanitizeTitle('조건 × 2')).toBe('조건_2');
    expect(sanitizeTitle('A/B 테스트')).toBe('AB_테스트');
    expect(sanitizeTitle('Note: 1')).toBe('Note_1');
  });

  // #165: IND+ and IND- must not become the same name.
  it('spells out a + or - ending a word', () => {
    expect(sanitizeTitle('IND+')).toBe('IND_plus');
    expect(sanitizeTitle('IND-')).toBe('IND_minus');
    expect(sanitizeTitle('발현 IND+ 대조')).toBe('발현_IND_plus_대조');
    expect(sanitizeTitle('IND+/IND-')).toBe('IND_plus_IND_minus');
    expect(sanitizeTitle('(IND-)')).toBe('IND_minus');
    expect(sanitizeTitle('C++ 코드')).toBe('C_plus_코드');
    expect(sanitizeTitle('RNA-seq')).toBe('RNA-seq');
    expect(sanitizeTitle('M1-M8')).toBe('M1-M8');
    expect(sanitizeTitle('A+B')).toBe('AB');
  });

  // #53: the experiment command rejects these titles instead of making `003_`.
  it('sanitizes a symbols- or emoji-only title to an empty string', () => {
    expect(sanitizeTitle('***')).toBe('');
    expect(sanitizeTitle('🧫🧪')).toBe('');
    expect(sanitizeTitle('(!) ~ ?')).toBe('');
  });
});

describe('createWorkflowFileName', () => {
  const wf = { id: 'WD010', name: 'Design', description: '' };

  it('appends a sanitized alias', () => {
    expect(createWorkflowFileName('002', wf, '1차 설계')).toBe('002_WD010_Design_1차_설계.labnote.md');
  });

  // #148
  it('caps the ID_name_alias part at WORKFLOW_FILE_NAME_MAX code points', () => {
    expect(WORKFLOW_FILE_NAME_MAX).toBe(80);
    const name = createWorkflowFileName('002', wf, `${'가'.repeat(78)} 나다`);
    expect(name).toBe(`002_WD010_Design_${'가'.repeat(67)}.labnote.md`);
    expect(Array.from(name.slice(4, -'.labnote.md'.length))).toHaveLength(80);
    // The cut lands right after a separator, which is dropped.
    expect(createWorkflowFileName('002', wf, `${'가'.repeat(66)} 나`)).toBe(`002_WD010_Design_${'가'.repeat(66)}.labnote.md`);
  });

  // #53: an emoji-only alias used to leave `002_WD010_Design_.labnote.md`.
  it('drops an alias that sanitizes to nothing', () => {
    expect(createWorkflowFileName('002', wf, '🧫')).toBe('002_WD010_Design.labnote.md');
    expect(createWorkflowFileName('002', wf, '  ')).toBe('002_WD010_Design.labnote.md');
  });
});

// #382: a note whose number was deleted from its name.
describe('planWorkflowRenumber and names without a number', () => {
  it('numbers a listed one by its place, and leaves an unlisted one alone', () => {
    const names = ['001_WD010_A.labnote.md', 'WT110_B.labnote.md', '002_WB030_C.labnote.md', 'WT120_D.labnote.md'];
    expect(planWorkflowRenumber(names, ['001_WD010_A.labnote.md', 'WT110_B.labnote.md', '002_WB030_C.labnote.md'])).toEqual([
      { from: 'WT110_B.labnote.md', to: '002_WT110_B.labnote.md' },
      { from: '002_WB030_C.labnote.md', to: '003_WB030_C.labnote.md' },
    ]);
  });
});

// #381
describe('matchMissingChecklistEntries', () => {
  const readme = (links: string[]): string =>
    ['## 🗂️ Related Workflows', '', ...links.map(l => `- [ ] [x](${l})`), ''].join('\n');

  it('pairs an entry whose file is gone with the one unlisted file of the same workflow', () => {
    const names = ['001_WD010_A.labnote.md', '004_WB030_C.labnote.md'];
    expect(matchMissingChecklistEntries(readme(['./001_WD010_A.labnote.md', '003_WB030_C.labnote.md']), names)).toEqual({
      relink: [{ from: '003_WB030_C.labnote.md', to: '004_WB030_C.labnote.md' }],
      missing: [],
    });
  });

  it('leaves it missing when no file, or more than one, matches', () => {
    expect(matchMissingChecklistEntries(readme(['003_WB030_C.labnote.md']), ['001_WD010_A.labnote.md']).missing).toEqual([
      '003_WB030_C.labnote.md',
    ]);
    const two = ['001_WB030_C.labnote.md', '002_WB030_C.labnote.md'];
    expect(matchMissingChecklistEntries(readme(['003_WB030_C.labnote.md']), two)).toEqual({
      relink: [],
      missing: ['003_WB030_C.labnote.md'],
    });
  });
});

// #355
describe('unitOpsAllEnded', () => {
  const op = (end: string): string => `### [UHW010 A]\n#### Meta\n- Start_date: '2026-10-25 08:00'\n- End_date: '${end}'\n`;
  it('is true only when every unit operation has an End_date', () => {
    expect(unitOpsAllEnded(`---\nend_date: ''\n---\n${op('2026-10-25 09:00')}${op('2026-10-25 10:00')}`)).toBe(true);
    expect(unitOpsAllEnded(`${op('2026-10-25 09:00')}${op('')}`)).toBe(false);
    expect(unitOpsAllEnded('# no unit operations\n')).toBe(false);
  });
});

describe('workflowAliasProblem', () => {
  it('refuses a "#" anywhere', () => {
    expect(workflowAliasProblem('1차 #2')).toBe('hash');
    expect(workflowAliasProblem('#1')).toBe('hash');
    expect(workflowAliasProblem('1차 37도')).toBeUndefined();
  });

  // #421
  it('refuses a "*" and a "_" the reading view takes for italics', () => {
    expect(workflowAliasProblem('블록_경계_설계')).toBe('markdown');
    expect(workflowAliasProblem('AF_구조_예측')).toBe('markdown');
    expect(workflowAliasProblem('WT*')).toBe('markdown');
    expect(workflowAliasProblem('pUC19_v2 run')).toBeUndefined();
    expect(workflowAliasProblem('블록 경계 설계')).toBeUndefined();
  });
});

// #412: a file name with a space is linked as `%20`.
describe('checklist links with spaces', () => {
  const OLD = '001_WD010_A B.labnote.md';
  const NEW = '003_WD010_A B.labnote.md';
  const B = '002_WB030_B.labnote.md';

  it('decodes a link, keeping a malformed escape as written', () => {
    expect(decodeChecklistLink('./001_A%20B.labnote.md')).toBe('./001_A B.labnote.md');
    expect(decodeChecklistLink('001_%E0%A4%A.labnote.md')).toBe('001_%E0%A4%A.labnote.md');
  });

  it('relinks and relabels an entry Obsidian has not updated', () => {
    const readme = readmeWith(['- [ ] [WD010 A B](./001_WD010_A%20B.labnote.md)']);
    const res = reconcileWorkflowChecklist(readme, [{ from: OLD, to: NEW }], { labelFor: () => 'WD010 A B 2차' });
    expect(res.content).toBe(readmeWith(['- [ ] [WD010 A B 2차](./003_WD010_A%20B.labnote.md)']));
  });

  it('relabels an entry Obsidian already relinked', () => {
    const readme = readmeWith(['- [ ] [WD010 A B](./003_WD010_A%20B.labnote.md)']);
    const res = reconcileWorkflowChecklist(readme, [{ from: OLD, to: NEW }], { labelFor: () => 'WD010 A B 2차' });
    expect(res.content).toBe(readmeWith(['- [ ] [WD010 A B 2차](./003_WD010_A%20B.labnote.md)']));
  });

  it('moves a renumbered entry into number order', () => {
    const readme = readmeWith(['- [ ] [WD010 A B](./003_WD010_A%20B.labnote.md)', `- [ ] [B](./${B})`]);
    const res = reconcileWorkflowChecklist(readme, [{ from: OLD, to: NEW }], { move: true });
    expect(res.content).toBe(readmeWith([`- [ ] [B](./${B})`, '- [ ] [WD010 A B](./003_WD010_A%20B.labnote.md)']));
  });
});
