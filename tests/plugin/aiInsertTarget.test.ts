/**
 * #112: "AI: Summarize results" and "AI: Draft Method section" wrote the reply
 * into whatever note the tab showed when it arrived. The reply now goes in
 * only while the starting note is still open; otherwise it opens in the answer
 * dialog, which checks again on "Insert into note".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EditTarget } from '@labnoteo/core';
import { Notice, __setGetLanguage } from '../stubs/obsidian';
import { draftMethodCommand, replyLanguageInstruction, summarizeResultsCommand } from '../../src/llm/commands';
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
    expect(opts.content).toMatch(/^> \[!note\] AI summary \(llama3\.1, \d{4}-\d{2}-\d{2}\)\n> - 요약$/);
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

describe('draftMethodCommand (#112)', () => {
  const inMethod = BODY.indexOf('#### Method') + 2;

  it("fills the unit operation's Method in the note it started from", async () => {
    const start = makeTarget(NOTE, inMethod);
    open = start;
    replyAfterSwitch('1. 원심분리');
    await draftMethodCommand(plugin);

    expect(start.text).toContain('#### Method\n\n1. 원심분리');
    expect(Notice.shown).toContain('Inserted the Method draft into 001_WD010_A.labnote.md.');
  });

  it("does not overwrite a same-named unit operation's Method in another note", async () => {
    open = makeTarget(NOTE, inMethod);
    const other = makeTarget(OTHER, inMethod);
    replyAfterSwitch('1. 원심분리', other);
    await draftMethodCommand(plugin);

    expect(other.replaceRange).not.toHaveBeenCalled();
    expect(dialog().content).toBe('1. 원심분리');
  });

  it("writes into the Method from the dialog after returning", async () => {
    open = makeTarget(NOTE, inMethod);
    replyAfterSwitch('1. 원심분리', makeTarget(OTHER, 0));
    await draftMethodCommand(plugin);
    const back = makeTarget(NOTE, 0);
    open = back;

    expect(await dialog().onInsert()).toBe(true);
    expect(back.text).toContain('#### Method\n\n1. 원심분리');
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
