/**
 * #112: "AI: Summarize results" and "AI: Draft Method section" wrote the reply
 * into whatever note the tab showed when it arrived. The reply now goes in
 * only while the starting note is still open; otherwise it opens in the answer
 * dialog, which checks again on "Insert into note".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EditTarget } from '@labnoteo/core';
import { Notice, __setGetLanguage } from '../stubs/obsidian';
import {
  draftMethodCommand,
  replyLanguageInstruction,
  summarizeExperimentCommand,
  summarizeResultsCommand,
} from '../../src/llm/commands';
import { aiAnswerModal, type AiAnswerOpts } from '../../src/modals';
import type LabnotePlugin from '../../src/main';

const chat = vi.fn();
vi.mock('../../src/llm/provider', () => ({
  createLlmProvider: vi.fn(() => ({ name: 'Fake', chat })),
}));
vi.mock('../../src/modals', () => ({ aiAnswerModal: vi.fn() }));

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const OTHER = 'labnote/001_Test/002_WB030_B.labnote.md';
const BODY = [
  '## [WD010 A]',
  '',
  '---',
  '',
  '### [UHW010 Spin]',
  '',
  '#### Method',
  '',
  '',
  '#### Output',
  '',
  '## 결과',
  '',
  '결과 문단',
  '',
].join('\n');

type Target = Omit<EditTarget, 'path'> & { text: string; path: string };

function makeTarget(path: string, cursor: number): Target {
  const target: Target = {
    path,
    text: BODY,
    getText: async () => target.text,
    insertAtCursor: vi.fn(async () => {}),
    replaceRange: vi.fn(async (from: number, to: number, text: string) => {
      target.text = target.text.slice(0, from) + text + target.text.slice(to);
    }),
    getCursorOffset: async () => cursor,
    revealOffset: vi.fn(async () => {}),
  };
  return target;
}

let open: Target | undefined;
let plugin: LabnotePlugin;
/** Stands in for Obsidian's index: a TFile whose `path` follows a rename. */
let files: Map<string, { path: string }>;

beforeEach(() => {
  chat.mockReset();
  vi.mocked(aiAnswerModal).mockReset();
  Notice.reset();
  open = makeTarget(NOTE, BODY.indexOf('결과 문단'));
  files = new Map([NOTE, OTHER].map(p => [p, { path: p }]));
  plugin = {
    app: { vault: { getFileByPath: (p: string) => files.get(p) } },
    settings: { globalSampleFolder: 'resources/labsamples', customSampleTypes: [], llmModel: 'llama3.1' },
    t: (key: string, ...args: string[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, a), key),
    host: {
      editTarget: () => open,
      confirm: vi.fn(async () => true),
    },
    markUserEdit: vi.fn(),
  } as unknown as LabnotePlugin;
});

/** Reply with `content`, after switching the open note to `next` (if given). */
function replyAfterSwitch(content: string, next?: Target): void {
  chat.mockImplementation(async () => {
    if (next) open = next;
    return { content };
  });
}

function dialog(): AiAnswerOpts {
  expect(aiAnswerModal).toHaveBeenCalledTimes(1);
  return vi.mocked(aiAnswerModal).mock.calls[0][1];
}

describe('summarizeResultsCommand (#112)', () => {
  it('inserts into the note it started from while that note is open', async () => {
    const start = open!;
    replyAfterSwitch('- 요약');
    await summarizeResultsCommand(plugin);

    expect(start.text).toContain('- 요약');
    expect(aiAnswerModal).not.toHaveBeenCalled();
    expect(plugin.markUserEdit).toHaveBeenCalledWith(NOTE);
    expect(Notice.shown).toContain('Inserted the summary into 001_WD010_A.labnote.md.');
  });

  it('leaves another note alone and opens the dialog instead', async () => {
    const other = makeTarget(OTHER, 0);
    replyAfterSwitch('- 요약', other);
    await summarizeResultsCommand(plugin);

    expect(other.replaceRange).not.toHaveBeenCalled();
    expect(plugin.markUserEdit).not.toHaveBeenCalled();
    const opts = dialog();
    // #150: the summary is a callout naming the model and the date.
    expect(opts.content).toMatch(/^> \[!note\] AI workflow results summary \(llama3\.1, \d{4}-\d{2}-\d{2}\)\n> - 요약$/);
    expect(opts.sourcePath).toBe(NOTE);

    expect(await opts.onInsert()).toBe(false);
    expect(other.replaceRange).not.toHaveBeenCalled();
    expect(Notice.shown).toContain('That note is no longer open. Copy the answer instead.');
  });

  // #260: renaming the note while the model writes is still the same note.
  it('inserts into the note it started from after it was renamed', async () => {
    const start = open!;
    const renamed = 'labnote/001_Test/001_WD010_A_fixed.labnote.md';
    chat.mockImplementation(async () => {
      files.get(NOTE)!.path = renamed;
      start.path = renamed;
      return { content: '- 요약' };
    });
    await summarizeResultsCommand(plugin);

    expect(start.text).toContain('- 요약');
    expect(aiAnswerModal).not.toHaveBeenCalled();
    expect(Notice.shown).toContain('Inserted the summary into 001_WD010_A_fixed.labnote.md.');
  });

  // #257: a note holding only the template got invented measurements back.
  it('stops before asking the model when no results are written yet', async () => {
    open = makeTarget(NOTE, 0);
    open.text = BODY.replace('## 결과\n\n결과 문단\n', '');
    await summarizeResultsCommand(plugin);

    expect(chat).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(
      'No results to summarize yet. Write them under a unit operation\'s "Results & Discussions", "QC Metrics" or "Discussion", a software unit operation\'s "Output", or "Conclusions and Discussion", and run this again.'
    );
  });

  it('sends the note without the template wording, and tells the model not to invent results', async () => {
    const start = open!;
    start.text = BODY.replace('#### Output\n', '#### Output\n- (samples to the next step)\n');
    replyAfterSwitch('- 요약');
    await summarizeResultsCommand(plugin);

    const [messages] = chat.mock.calls[0] as [{ role: string; content: string }[]];
    expect(messages[0].content).toContain('never invent a number');
    expect(messages[1].content).not.toContain('(samples to the next step)');
    expect(messages[1].content).toContain('결과 문단');
  });

  it('inserts from the dialog once the user is back in that note', async () => {
    replyAfterSwitch('- 요약', makeTarget(OTHER, 0));
    await summarizeResultsCommand(plugin);
    const back = makeTarget(NOTE, BODY.indexOf('결과 문단'));
    open = back;

    expect(await dialog().onInsert()).toBe(true);
    expect(back.text).toContain('- 요약');
    expect(plugin.markUserEdit).toHaveBeenCalledWith(NOTE);
  });
});

// #279: the summary went after the cursor line, and the model got the whole note.
describe('summarizeResultsCommand in a workflow note (#279)', () => {
  const NOTE_BODY = [
    '---',
    'title: WD010 A',
    '---',
    '## [WD010 A]',
    '',
    '### [UHW010 Spin] 조건 A',
    '',
    '#### Reagent',
    '- Tris 50 mM',
    '',
    '#### Results & Discussions',
    '수율 82%',
    '',
    '## Conclusions and Discussion',
    '',
    '내 결론 메모',
    '',
    '',
  ].join('\n');

  it('sends only the result sections and puts the summary at the end of Conclusions', async () => {
    const start = makeTarget(NOTE, 0);
    start.text = NOTE_BODY;
    open = start;
    replyAfterSwitch('- 수율 82%');
    await summarizeResultsCommand(plugin);

    const [messages] = chat.mock.calls[0] as [{ role: string; content: string }[]];
    expect(messages[1].content).toContain('[UHW010 Spin] 조건 A › Results & Discussions\n수율 82%');
    expect(messages[1].content).not.toContain('Tris');
    expect(messages[1].content).not.toContain('title: WD010 A');
    expect(start.text).toMatch(/내 결론 메모\n\n> \[!note\] AI workflow results summary \(llama3\.1, [\d-]+\)\n> - 수율 82%\n/);
  });

  it('asks before replacing the summary an earlier run left there', async () => {
    const start = makeTarget(NOTE, 0);
    start.text = NOTE_BODY.replace('내 결론 메모\n', '내 결론 메모\n\n> [!note] AI workflow results summary (old, 2026-01-01)\n> - 옛 요약\n');
    open = start;
    replyAfterSwitch('- 새 요약');
    await summarizeResultsCommand(plugin);

    expect(plugin.host.confirm).toHaveBeenCalledWith(expect.stringContaining('already has an AI summary'), expect.objectContaining({ destructive: true }));
    expect(start.text).not.toContain('옛 요약');
    expect(start.text.match(/AI workflow results summary/g)).toHaveLength(1);
    expect(start.text).toContain('내 결론 메모\n\n> [!note] AI workflow results summary (llama3.1');
  });

  it('points a README at the experiment summary instead', async () => {
    open = makeTarget('labnote/001_Test/README.labnote.md', 0);
    await summarizeResultsCommand(plugin);
    expect(chat).not.toHaveBeenCalled();
    expect(Notice.shown).toContain('In an experiment README, run "AI: Summarize experiment results".');
  });
});

// #306: there was no way to summarize a whole experiment.
describe('summarizeExperimentCommand (#306)', () => {
  const README = 'labnote/001_Test/README.labnote.md';
  const README_BODY = [
    '---',
    'title: Test',
    '---',
    '## 🗂️ Related Workflows',
    '- [ ] [B](./002_WB030_B.labnote.md)',
    '- [ ] [A](./001_WD010_A.labnote.md)',
    '',
    '## Summary and Discussion',
    '',
    '연구원 메모',
    '',
  ].join('\n');
  const notes: Record<string, string> = {
    [NOTE]: '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\nA 결과\n',
    [OTHER]: '## [WB030 B]\n\n### [UHW020 Mix]\n\n#### Results & Discussions\nB 결과\n',
  };

  function withVault(texts: Record<string, string>): void {
    const tfiles = Object.keys(texts).map(p => ({ path: p, name: p.split('/').pop()!, parent: { path: 'labnote/001_Test' } }));
    plugin.app = {
      vault: {
        getFileByPath: (p: string) => tfiles.find(f => f.path === p) ?? files.get(p),
        getMarkdownFiles: () => tfiles,
        cachedRead: async (f: { path: string }) => texts[f.path],
      },
      workspace: { getLeavesOfType: () => [] },
    } as unknown as LabnotePlugin['app'];
  }

  it('sends the results of each workflow in checklist order with the README notes, into Summary and Discussion', async () => {
    withVault(notes);
    const start = makeTarget(README, 0);
    start.text = README_BODY;
    open = start;
    replyAfterSwitch('- 전체 요약');
    await summarizeExperimentCommand(plugin);

    const [messages] = chat.mock.calls[0] as [{ role: string; content: string }[]];
    const user = messages[1].content;
    expect(user).toContain('연구원 메모');
    expect(user.indexOf('B 결과')).toBeLessThan(user.indexOf('A 결과'));
    expect(start.text).toMatch(/연구원 메모\n\n> \[!note\] AI experiment results summary \(llama3\.1, [\d-]+\)\n> - 전체 요약\n$/);
    expect(Notice.shown).toContain('Summarized the results of 2 workflow note(s) into README.labnote.md.');
  });

  it('stops without asking the model while no workflow note has results', async () => {
    withVault({ [NOTE]: '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Results & Discussions\n- (Any results and discussions. Link file path if needed)\n' });
    const start = makeTarget(README, 0);
    start.text = README_BODY;
    open = start;
    await summarizeExperimentCommand(plugin);
    expect(chat).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(
      'No results are written in the workflow notes of this experiment yet, so there is nothing to summarize.'
    );
  });
});

describe('draftMethodCommand (#112)', () => {
  const inMethod = BODY.indexOf('#### Method') + 2;

  it("fills the unit operation's Method in the note it started from", async () => {
    const start = makeTarget(NOTE, inMethod);
    open = start;
    replyAfterSwitch('1. 원심분리');
    await draftMethodCommand(plugin);

    // #280: the draft is marked as the model's until someone removes the line.
    expect(start.text).toMatch(/#### Method\n\n> \[!note\] AI draft \(llama3\.1, [\d-]+\) — review it, then delete this line\n\n1\. 원심분리/);
    expect(Notice.shown).toContain('Inserted the Method draft into 001_WD010_A.labnote.md.');
  });

  it("does not overwrite a same-named unit operation's Method in another note", async () => {
    open = makeTarget(NOTE, inMethod);
    const other = makeTarget(OTHER, inMethod);
    replyAfterSwitch('1. 원심분리', other);
    await draftMethodCommand(plugin);

    expect(other.replaceRange).not.toHaveBeenCalled();
    expect(dialog().content).toMatch(/^> \[!note\] AI draft .*\n\n1\. 원심분리$/);
  });

  it("writes into the Method from the dialog after returning", async () => {
    open = makeTarget(NOTE, inMethod);
    replyAfterSwitch('1. 원심분리', makeTarget(OTHER, 0));
    await draftMethodCommand(plugin);
    const back = makeTarget(NOTE, 0);
    open = back;

    expect(await dialog().onInsert()).toBe(true);
    expect(back.text).toMatch(/#### Method\n\n> \[!note\] AI draft .*\n\n1\. 원심분리/);
    expect(plugin.markUserEdit).toHaveBeenCalledWith(NOTE);
  });
});

// #195: an empty reply (a thinking model that only thought) ended with no notice at all.
describe('empty AI reply (#195)', () => {
  it('tells the user the model gave no answer and leaves the note alone', async () => {
    chat.mockResolvedValue({ content: '', toolCalls: [], thinkingOnly: true });
    const target = makeTarget(NOTE, BODY.indexOf('#### Method') + '#### Method\n'.length);
    open = target;
    await draftMethodCommand(plugin);
    expect(Notice.shown).toContain('The model gave no answer (it only thought). Try again or choose another model.');
    expect(target.replaceRange).not.toHaveBeenCalled();
    expect(aiAnswerModal).not.toHaveBeenCalled();

    Notice.reset();
    chat.mockResolvedValue({ content: '  ', toolCalls: [] });
    await summarizeResultsCommand(plugin);
    expect(Notice.shown).toContain('The model gave no answer. Try again or choose another model.');
    expect(target.replaceRange).not.toHaveBeenCalled();
  });
});

// #237: the reply follows Obsidian's language, not the note's or the prompt's.
describe('reply language', () => {
  afterEach(() => __setGetLanguage(undefined));

  it('names the language in words', () => {
    expect(replyLanguageInstruction('ko')).toContain('Write the answer in Korean.');
    expect(replyLanguageInstruction('en')).toContain('Write the answer in English.');
    expect(replyLanguageInstruction('zh-TW')).toContain('Write the answer in Chinese.');
  });

  it("asks for Korean in the summary and Method prompts of a Korean UI", async () => {
    __setGetLanguage(() => 'ko');
    replyAfterSwitch('- 요약');
    await summarizeResultsCommand(plugin);
    open = makeTarget(NOTE, BODY.indexOf('#### Method') + '#### Method\n'.length);
    replyAfterSwitch('1. 원심분리');
    await draftMethodCommand(plugin);
    const systems = chat.mock.calls.map(c => (c[0] as { role: string; content: string }[])[0]);
    expect(systems).toHaveLength(2);
    for (const s of systems) {
      expect(s.role).toBe('system');
      expect(s.content).toContain('Write the answer in Korean.');
    }
  });
});
