/**
 * The "Delete earlier scan" button of the scan results (#576), as the modal wires it: the
 * question goes to `confirmDelete`; a no says nothing and keeps the button; a yes says what was
 * done and removes the button once nothing earlier is left; a failure is said in a notice and
 * the button stays to try again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { Notice } from '../stubs/obsidian';
import type { ScanPipeline, ScanResult } from '../../src/scan/scanPipeline';
import type { Translator } from '../../packages/labnoteo-core/src/i18n/translator';
import { formatMessage } from '../../packages/labnoteo-core/src/i18n/translator';

type Button = { text: string; click?: () => unknown; removed: boolean };
const buttons: Button[] = [];

vi.mock('obsidian', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  class Setting {
    controlEl = { empty: () => undefined };
    constructor(_el: unknown) {}
    setName() { return this; }
    setDesc() { return this; }
    addButton(make: (b: unknown) => unknown) {
      const rec: Button = { text: '', removed: false };
      buttons.push(rec);
      const b = {
        buttonEl: { remove: () => void (rec.removed = true) },
        setButtonText: (s: string) => ((rec.text = s), b),
        setTooltip: () => b,
        setWarning: () => b,
        setCta: () => b,
        setDisabled: () => b,
        onClick: (fn: () => unknown) => ((rec.click = fn), b),
      };
      make(b);
      return this;
    }
  }
  return { ...real, Setting };
});

const { ScanResultModal } = await import('../../src/scan/resultModal');

const t: Translator = (key, ...args) => formatMessage(key, args);
const IMAGE = { name: 'old.jpg', path: 'labnote/001_A/images/old.jpg' };

function result(): ScanResult {
  return {
    source: 'new.jpg',
    status: 'filed',
    notePath: 'labnote/001_A/001_WD010_A.labnote.md',
    imagePath: 'labnote/001_A/images/new.jpg',
    hash: 'bbbbbbbbbbbb',
    previous: [{ hash: 'aaaaaaaaaaaa', embed: '![[old.jpg]]' }],
    payload: { kind: 'page', noteId: 'LN-7K3M9QX2', unitOp: 'aaaa', page: 1, pageCount: 1 } as unknown as ScanResult['payload'],
  };
}

async function clickDelete(
  pipeline: Pick<ScanPipeline, 'previousImagesPlan' | 'removePrevious' | 'undo'>,
  answer: boolean
): Promise<{ button: Button; asked: string[] }> {
  buttons.length = 0;
  const asked: string[] = [];
  const modal = new ScanResultModal({} as App, t, pipeline as ScanPipeline, [result()], {
    openNote: () => undefined,
    openUnmatched: () => undefined,
    confirmDelete: async (m: string) => {
      asked.push(m);
      return answer;
    },
  });
  modal.onOpen();
  const button = buttons.find(b => b.text === 'Delete earlier scan')!;
  expect(button).toBeDefined();
  expect(button.click!()).toBeUndefined();
  await vi.waitFor(() => expect(asked.length).toBe(1));
  await new Promise(r => setTimeout(r, 0));
  return { button, asked };
}

describe('the Delete earlier scan button', () => {
  beforeEach(() => Notice.reset());
  const plan = async () => ({ trash: [IMAGE], kept: [] });

  it('does nothing on no: no removal, no notice, the button stays', async () => {
    const removePrevious = vi.fn(async () => ({ removed: 1, trashed: 1 }));
    const { button, asked } = await clickDelete({ previousImagesPlan: plan, removePrevious, undo: async () => false } as never, false);
    expect(asked[0]).toContain('These images go to the trash:\n- old.jpg');
    expect(removePrevious).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([]);
    expect(button.removed).toBe(false);
  });

  it('says what was done on yes and removes the button', async () => {
    const { button } = await clickDelete(
      { previousImagesPlan: plan, removePrevious: async () => ({ removed: 1, trashed: 0 }), undo: async () => false } as never,
      true
    );
    expect(Notice.shown).toEqual(['Removed 1 earlier scan(s) from the note and moved 0 image(s) to the trash.']);
    expect(button.removed).toBe(true);
  });

  it('keeps the button when the note was not written', async () => {
    const { button } = await clickDelete({ previousImagesPlan: plan, removePrevious: async () => 'notWritten', undo: async () => false } as never, true);
    expect(Notice.shown[0]).toContain('was not written');
    expect(button.removed).toBe(false);
  });

  it('says a failure in a notice and keeps the button', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { button } = await clickDelete(
      {
        previousImagesPlan: plan,
        removePrevious: async () => {
          throw new Error('EBUSY note.md');
        },
        undo: async () => false,
      } as never,
      true
    );
    error.mockRestore();
    warn.mockRestore();
    expect(Notice.shown).toEqual(['Command failed: EBUSY note.md']);
    expect(button.removed).toBe(false);
  });
});
