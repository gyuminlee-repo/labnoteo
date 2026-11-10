/**
 * #77: "Ask the AI assistant" used to append the final answer to the note
 * without asking. The answer now opens in a dialog, and only "Insert into
 * note" changes the note — and only while that note is still open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EditTarget } from '@labnoteo/core';
import { Notice } from '../stubs/obsidian';
import { askAgentCommand } from '../../src/llm/commands';
import { runAgent } from '../../src/llm/agent';
import { aiAnswerModal, type AiAnswerOpts } from '../../src/modals';
import { createObsidianTranslator } from '../../src/i18n';
import type LabnotePlugin from '../../src/main';

vi.mock('../../src/llm/provider', () => ({
  createLlmProvider: vi.fn(() => ({ name: 'Fake', chat: vi.fn() })),
}));
vi.mock('../../src/llm/agent', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/llm/agent')>()),
  runAgent: vi.fn(),
}));
vi.mock('../../src/modals', () => ({ aiAnswerModal: vi.fn() }));

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const BODY = '## [WD010 A]\n\n결과 문단';

function makeTarget(path = NOTE): EditTarget {
  return {
    path,
    getText: async () => BODY,
    insertAtCursor: vi.fn(async () => {}),
    replaceRange: vi.fn(async () => {}),
    getCursorOffset: async () => BODY.length,
    revealOffset: vi.fn(async () => {}),
  };
}

let open: EditTarget | undefined;
let plugin: LabnotePlugin;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(aiAnswerModal).mockReset();
  Notice.reset();
  open = makeTarget();
  plugin = {
    app: {},
    settings: { globalSampleFolder: 'resources/labsamples', customSampleTypes: [] },
    t: (key: string, ...args: string[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, a), key),
    host: {
      editTarget: () => open,
      prompt: async () => '요약해 줘',
      confirm: vi.fn(),
    },
    markUserEdit: vi.fn(),
    toolFs: () => undefined,
  } as unknown as LabnotePlugin;
  vi.mocked(runAgent).mockResolvedValue({ content: '**답변**', executed: [], stoppedAtLimit: false });
});

/** Run the command and return what it handed to the answer dialog. */
async function ask(): Promise<AiAnswerOpts> {
  await askAgentCommand(plugin);
  expect(aiAnswerModal).toHaveBeenCalledTimes(1);
  return vi.mocked(aiAnswerModal).mock.calls[0][1];
}

describe('askAgentCommand (#77)', () => {
  it('shows the answer in a dialog instead of writing it to the note', async () => {
    const target = open!;
    const opts = await ask();

    expect(opts.content).toBe('**답변**');
    expect(opts.sourcePath).toBe(NOTE);
    expect(target.replaceRange).not.toHaveBeenCalled();
    expect(target.insertAtCursor).not.toHaveBeenCalled();
  });

  it('sends the note body with the goal', async () => {
    await ask();
    const messages = vi.mocked(runAgent).mock.calls[0][0];
    expect(messages[1].content).toBe(`요약해 줘\n\nActive note:\n${BODY}`);
    expect(messages[0].content).toContain('not written to the note');
  });

  it('inserts the answer when asked while the note is still open', async () => {
    const opts = await ask();
    const current = makeTarget();
    open = current;

    expect(await opts.onInsert()).toBe(true);
    expect(current.replaceRange).toHaveBeenCalledTimes(1);
    expect(vi.mocked(current.replaceRange).mock.calls[0][2]).toContain('**답변**');
    expect(plugin.markUserEdit).toHaveBeenCalledWith(NOTE);
  });

  // #544: the goal prompt, the approvals and the answer dialog each take the
  // focus, and the Source-mode editor then reports the start of the note.
  it('inserts at the cursor read before the dialogs, not the one reported after them', async () => {
    const target = { ...makeTarget(), getCursorOffset: async () => cursor };
    let cursor = BODY.indexOf('결과');
    open = target;

    const opts = await ask();
    cursor = 0;

    expect(await opts.onInsert()).toBe(true);
    expect(vi.mocked(target.replaceRange).mock.calls[0][0]).toBe(BODY.length);
  });

  it('falls back to the end of the note when a tool the agent ran changed it', async () => {
    const changed = `${BODY}\n\n## [UHW010 Spin]\n`;
    let text = BODY;
    const target = { ...makeTarget(), getText: async () => text, getCursorOffset: async () => 0 };
    open = target;

    const opts = await ask();
    text = changed;

    expect(await opts.onInsert()).toBe(true);
    expect(vi.mocked(target.replaceRange).mock.calls[0][0]).toBe(changed.length);
  });

  it('does not insert once another note is open', async () => {
    const opts = await ask();
    const other = makeTarget('labnote/001_Test/002_WB030_B.labnote.md');
    open = other;

    expect(await opts.onInsert()).toBe(false);
    expect(other.replaceRange).not.toHaveBeenCalled();
    expect(Notice.shown).toContain('That note is no longer open. Copy the answer instead.');
  });

  it('opens no dialog for an empty answer', async () => {
    vi.mocked(runAgent).mockResolvedValue({ content: '', executed: [], stoppedAtLimit: false });
    await askAgentCommand(plugin);
    expect(aiAnswerModal).not.toHaveBeenCalled();
  });

  // #161: only "ran 0 tool call(s)" was shown when the model neither answered nor acted.
  it('says the request may be outside its tools when there is no answer and no tool call', async () => {
    vi.mocked(runAgent).mockResolvedValue({ content: '  ', executed: [], stoppedAtLimit: false });
    await askAgentCommand(plugin);
    expect(Notice.shown).toContain(
      'The assistant gave no answer. What you asked may be outside the tools it can use.'
    );
    // Changed expectation (#186): the end notice now says plainly that nothing changed.
    expect(Notice.shown).toContain('The AI used no tools; nothing in the vault changed.');
  });

  // #195: a thinking model's empty answer says so instead of passing silently.
  it('names a thinking-only empty answer', async () => {
    vi.mocked(runAgent).mockResolvedValue({ content: '', thinkingOnly: true, executed: [], stoppedAtLimit: false });
    await askAgentCommand(plugin);
    expect(Notice.shown).toContain('The model gave no answer (it only thought). Try again or choose another model.');
  });

  // #186: a write denied in the approval dialog counted as a tool call that ran.
  it('tells denied writes from changes in the end notice', async () => {
    const c = { id: 'call_0', name: 'create_sample', arguments: {} };
    vi.mocked(runAgent).mockResolvedValue({
      content: '',
      executed: [{ call: c, outcome: 'denied', mutates: true }],
      stoppedAtLimit: false,
    });
    await askAgentCommand(plugin);
    expect(Notice.shown).toContain('The assistant gave no answer.');
    expect(Notice.shown).toContain('AI tool calls: 1 denied by you. Nothing in the vault changed.');

    Notice.reset();
    vi.mocked(runAgent).mockResolvedValue({
      content: '끝',
      executed: [
        { call: c, outcome: 'done', mutates: true },
        { call: c, outcome: 'done', mutates: false },
        { call: c, outcome: 'failed', mutates: true, error: 'Sample not found' },
      ],
      stoppedAtLimit: false,
    });
    await askAgentCommand(plugin);
    expect(Notice.shown).toContain('AI tool calls: 1 change(s) made, 1 lookup(s), 1 failed. Failed: create_sample — Sample not found.');
  });

  // #281: the end notice counted failures without saying why.
  it('names the first failures with their target and reason, and counts the rest', async () => {
    const fail = (alias: string, error: string) => ({
      call: { id: alias, name: 'create_sample', arguments: { alias, documentPath: 'labnote/001_A/001_WD010_A.labnote.md' } },
      outcome: 'failed' as const,
      mutates: true,
      error,
    });
    vi.mocked(runAgent).mockResolvedValue({
      content: '끝',
      executed: [
        fail('pET', 'Alias "pET" is already used by DNA-1 in this experiment'),
        fail('IPTG', 'x'.repeat(120)),
        { call: { id: 'r', name: 'update_section', arguments: { heading: 'Method' } }, outcome: 'rejected', mutates: true, error: 'No "Method" section' },
        fail('YE-22', 'bad'),
      ],
      stoppedAtLimit: false,
    });
    await askAgentCommand(plugin);
    const notice = Notice.shown.find(n => n.startsWith('AI tool calls'))!;
    expect(notice).toContain('Failed: create_sample (pET) — Alias "pET" is already used by DNA-1 in this experiment; ');
    expect(notice).toContain(`create_sample (IPTG) — ${'x'.repeat(79)}…; `);
    expect(notice).toContain('update_section (Method) — No "Method" section; +1 more.');
    expect(notice).toContain('Nothing in the vault changed.');
  });

  // #529: a rule the plugin knows was read out in English, and cut mid-sentence.
  it('words a named refusal in the language of the interface, then cuts it to length', async () => {
    plugin.t = createObsidianTranslator('ko') as LabnotePlugin['t'];
    vi.mocked(runAgent).mockResolvedValue({
      content: '끝',
      executed: [
        {
          call: { id: 'a', name: 'create_sample', arguments: { alias: 'pET;28a' } },
          outcome: 'rejected',
          mutates: true,
          error: 'Invalid alias "pET;28a": ";" and ":" separate the id, alias and description in a note. Replace them (e.g. with "-" or "/") and retry.',
          code: 'sample_alias_separator',
          params: ['pET;28a'],
        },
        {
          call: { id: 'b', name: 'create_sample', arguments: { type: 'XNA' } },
          outcome: 'failed',
          mutates: true,
          error: 'Unknown sample type "XNA". Known types: DNA, RNA.',
          code: 'sample_type_unknown',
          params: ['XNA', 'DNA, RNA'],
        },
        {
          call: { id: 'c', name: 'create_sample', arguments: {} },
          outcome: 'failed',
          mutates: true,
          error: 'type and documentPath are required',
        },
      ],
      stoppedAtLimit: false,
    });

    await askAgentCommand(plugin);

    const notice = Notice.shown.find(n => n.startsWith('AI 도구 호출'))!;
    // The Korean reading is 72 characters, so it arrives whole where the
    // English sentence was cut at 80.
    expect(notice).toContain(
      'create_sample (pET;28a) — 별칭에는 ";"나 ":"를 쓸 수 없습니다. 노트에서 ID·별칭·설명을 가르는 글자입니다. 대신 "-"나 "/"를 쓰세요(예: 1-10).'
    );
    expect(notice).toContain('create_sample — "XNA"은(는) 시료 타입이 아닙니다(DNA, RNA). Labnote 설정에서 먼저 추가하세요.');
    // No rule of ours: the model's own mistake stays as the tool put it.
    expect(notice).toContain('create_sample — type and documentPath are required.');
  });

  // #286: after a change the end notice is the answer, without "try again".
  it('does not ask to try again when the assistant changed something without answering', async () => {
    const c = { id: 'call_0', name: 'create_sample', arguments: {} };
    vi.mocked(runAgent).mockResolvedValue({
      content: '',
      thinkingOnly: true,
      executed: [{ call: c, outcome: 'done', mutates: true }],
      stoppedAtLimit: false,
    });
    await askAgentCommand(plugin);
    expect(Notice.shown.filter(n => n !== 'Contacting Fake…')).toEqual(['AI tool calls: 1 change(s) made.']);
  });

  it('lists its tools and asks the model to say what it cannot do', async () => {
    await ask();
    const system = vi.mocked(runAgent).mock.calls[0][0][0].content;
    expect(system).toContain('update_section');
    expect(system).toContain('experiment status');
  });
});
