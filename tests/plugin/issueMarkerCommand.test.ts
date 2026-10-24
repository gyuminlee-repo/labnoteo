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
