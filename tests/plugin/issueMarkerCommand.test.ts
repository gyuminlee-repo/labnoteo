/**
 * #293: on a README workflow entry the issue marker goes after the link. The
 * link becoming the marker would leave a line that is no longer an entry.
 */
import { describe, it, expect } from 'vitest';
import type { Editor } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { isWorkflowChecklistEntryLine } from '../../packages/labnoteo-core/src/lib/workflowStructure';
import { insertIssueMarkerCommand } from '../../src/commands';

const LINE = '- [ ] [WB030 Gibson](./001_WB030_Gibson.labnote.md)';

/** An editor over `text` whose positions are plain offsets. */
function fakeEditor(text: string, from: number, to = from) {
  let doc = text;
  let sel = { from, to };
  const editor = {
    getValue: () => doc,
    getCursor: (which?: string) => (which === 'to' ? sel.to : sel.from),
    posToOffset: (pos: number) => pos,
    offsetToPos: (offset: number) => offset,
    replaceRange: (insert: string, a: number, b: number) => {
      doc = doc.slice(0, a) + insert + doc.slice(b);
    },
    setCursor: (pos: number) => {
      sel = { from: pos, to: pos };
    },
  };
  return { editor: editor as unknown as Editor, text: () => doc };
}

function hostAnswering(answer: (value: string) => string | undefined) {
  const prompts: string[] = [];
  const host = {
    t: (s: string) => s,
    notify: () => {},
    prompt: async (opts: { value?: string }) => {
      prompts.push(opts.value ?? '');
      return answer(opts.value ?? '');
    },
  } as unknown as LabnoteHost;
  return { host, prompts };
}

describe('insertIssueMarkerCommand on a workflow checklist entry (#293)', () => {
  it('offers the label as the topic and appends the marker after the link', async () => {
    const { editor, text } = fakeEditor(LINE, LINE.length);
    const { host, prompts } = hostAnswering(v => v);

    expect(await insertIssueMarkerCommand(editor, host)).toBe(true);

    expect(prompts).toEqual(['WB030 Gibson']);
    expect(text()).toMatch(/^- \[ \] \[WB030 Gibson\]\(\.\/001_WB030_Gibson\.labnote\.md\) @issue;[^;]+;WB030 Gibson$/);
    expect(isWorkflowChecklistEntryLine(text())).toBe(true);
  });

  it('keeps the link when the label is selected', async () => {
    const start = LINE.indexOf('WB030');
    const { editor, text } = fakeEditor(LINE, start, start + 'WB030 Gibson'.length);
    const { host } = hostAnswering(() => undefined);

    expect(await insertIssueMarkerCommand(editor, host)).toBe(true);

    expect(text().startsWith(`${LINE} @issue;`)).toBe(true);
    expect(text().endsWith(';WB030 Gibson')).toBe(true);
  });
});

// #428: a marker in a note the automation does not read opened no issue, without a word.
describe('insertIssueMarkerCommand in a note that is not read for markers', () => {
  it.each(['labnote/002_ALE/랩미팅 메모.md', 'labnote/002_ALE/sub/001_WD010_A.labnote.md', 'Daily.md', ''])(
    'refuses in %s before asking for a topic',
    async path => {
      const { editor, text } = fakeEditor('질문', 2);
      const notes: string[] = [];
      const { host, prompts } = hostAnswering(v => v);
      Object.assign(host, { notify: (_: string, m: string) => notes.push(m) });

      expect(await insertIssueMarkerCommand(editor, host, path)).toBe(false);

      expect(prompts).toEqual([]);
      expect(text()).toBe('질문');
      expect(notes[0]).toMatch(/^Markers in this note open no issue/);
    }
  );

  it('inserts in a workflow note directly in the experiment folder', async () => {
    const { editor } = fakeEditor('질문', 2);
    const { host } = hostAnswering(v => v);
    expect(await insertIssueMarkerCommand(editor, host, 'labnote/002_ALE/001_WD010_A.labnote.md')).toBe(true);
  });
});

// #475: the topic window called the sentence the issue title without measuring it.
describe('insertIssueMarkerCommand with a long topic', () => {
  it.each([
    [201, 1],
    [200, 0],
  ])('warns about a %i-character topic that the title will shorten (%i warning)', async (length, warnings) => {
    const { editor, text } = fakeEditor('', 0);
    const notes: string[] = [];
    const { host } = hostAnswering(() => '가'.repeat(length));
    Object.assign(host, { notify: (_: string, m: string) => notes.push(m) });

    expect(await insertIssueMarkerCommand(editor, host)).toBe(true);

    expect(text()).toContain('가'.repeat(length));
    expect(notes.filter(n => n.startsWith('The topic sentence is'))).toHaveLength(warnings);
  });
});

// The note the editor shows changes while the topic prompt is open: that note is not marked.
// Another leaf showing the first note does not make it the editor's.
describe('insertIssueMarkerCommand when the editor goes to another note during the prompt', () => {
  it('warns and marks nothing', async () => {
    const TEXT = 'A sentence to discuss.';
    const { editor, text } = fakeEditor(TEXT, TEXT.length);
    let shown = 'labnote/001_Test/001_WD010_A.labnote.md';
    const notices: [string, string][] = [];
    const host = {
      t: (s: string) => s,
      notify: (level: string, msg: string) => notices.push([level, msg]),
      prompt: async () => {
        shown = 'labnote/001_Test/002_WD020_B.labnote.md';
        return 'Topic';
      },
      // Another leaf, still on A, is the active one.
      editTarget: () => ({ path: 'labnote/001_Test/001_WD010_A.labnote.md' }),
    } as unknown as LabnoteHost;
    expect(await insertIssueMarkerCommand(editor, host, 'labnote/001_Test/001_WD010_A.labnote.md', () => shown)).toBe(false);
    expect(text()).toBe(TEXT);
    expect(notices).toEqual([['warn', 'The note was switched to another while the command ran, so it was not changed. Run the command again.']]);
  });
});

