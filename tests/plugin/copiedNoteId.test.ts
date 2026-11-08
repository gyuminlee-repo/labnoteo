/**
 * L2: a copied note whose labnote_id cannot be written (over several lines) is said once by
 * BarcodeFeature.reassignCopiedId ('refused'); the copy flows then go no further with it.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile, TFolder } from '../stubs/obsidian';
import LabnotePlugin from '../../src/main';
import { BarcodeFeature } from '../../src/barcode/barcodeFeature';
import { NoteIdService } from '../../src/barcode/noteIdService';

// main.ts brings in every view and suggester; the stub has no base class for those.
vi.mock('obsidian', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  const Base = class {};
  return {
    ...real,
    Plugin: Base,
    PluginSettingTab: Base,
    ItemView: Base,
    EditorSuggest: Base,
    Menu: Base,
    WorkspaceLeaf: Base,
    getLanguage: () => 'en',
    loadPdfJs: async () => ({}),
    requireApiVersion: () => true,
    setIcon: () => {},
  };
});

type Status = 'renewed' | 'none' | 'refused' | 'failed';
const DIR = 'labnote/002_Copy';

function plugin(status: Status | ((path: string) => Status), notes: string[], text = '---\nlabnote_id: LN-7K3M9QX2\n  more\n---\nbody\n') {
  const files = new Map(notes.map(p => [p, text]));
  const renameFile = vi.fn(async () => {});
  const list = vi.fn(async () => [] as string[]);
  const makeCopyNewExperiment = vi.fn(async () => {});
  const reassignCopiedId = vi.fn(async (f: TFile): Promise<Status> => (typeof status === 'function' ? status(f.path) : status));
  const folder = Object.assign(new TFolder(), { path: DIR, name: '002_Copy' });
  folder.children = notes.map(p => new TFile(p));
  const readme = new TFile(`${DIR}/README.labnote.md`);
  const app = {
    vault: {
      read: async (f: TFile) => files.get(f.path) ?? '',
      process: async (f: TFile, fn: (s: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? '')); },
      getAbstractFileByPath: (p: string) => (p === readme.path ? readme : files.has(p) ? new TFile(p) : null),
      getMarkdownFiles: () => [],
    },
    fileManager: { renameFile },
    metadataCache: { getFileCache: () => null },
  };
  const p = Object.create(LabnotePlugin.prototype) as Record<string, unknown>;
  Object.assign(p, {
    app,
    host: { notify: vi.fn(), t: (s: string) => s },
    t: (s: string) => s,
    fs: { list, exists: async () => false },
    barcode: { reassignCopiedId },
    unloaded: false,
    copiedWorkflows: new Set<string>(),
    copiedExperiments: new Set<string>(),
    copyIdsRenewed: new Map<string, Set<string>>(),
    waitForNoModal: async () => true,
    waitForCopiedNotes: async () => {},
    readCopiedReadme: async () => ({}),
    makeCopyNewExperiment,
  });
  return { p, folder, renameFile, list, makeCopyNewExperiment, reassignCopiedId };
}

describe('copy flows and a note ID that cannot be written', () => {
  it('a copied workflow note goes no further: no name offered, no rename', async () => {
    const path = `${DIR}/001_WD010_A.labnote 1.md`;
    const { p, renameFile, list, reassignCopiedId } = plugin('refused', [path]);
    (p.copiedWorkflows as Set<string>).add(path);
    await (p as unknown as { offerCopiedWorkflowFix(f: TFile): Promise<void> }).offerCopiedWorkflowFix(new TFile(path));
    expect(reassignCopiedId).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
  });

  // As B6: the renewal is recorded for every note the copy handled, a refused one too, so a note
  // copied in later with the original's ID is still asked about; only the steps after (README
  // id, new experiment) are not taken.
  it('a copied experiment records its renewals as before but is not made a new experiment', async () => {
    const multi = `${DIR}/001_WD010_A.labnote.md`, renewedNote = `${DIR}/002_WD010_B.labnote.md`, none = `${DIR}/003_WD010_C.labnote.md`;
    const status = (path: string): Status => (path === multi ? 'refused' : path === renewedNote ? 'renewed' : 'none');
    // A scan entry, so the flow waits on copiedScanImages, where a new note comes in.
    const scan = '---\nlabnote_id: LN-7K3M9QX2\n---\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[a.jpg]]\n*a*\n';
    const { p, folder, makeCopyNewExperiment } = plugin(status, [multi, renewedNote, none], scan);
    const late = `${DIR}/004_WD010_D.labnote.md`;
    let questions = 0;
    // barcodeFeature's 'changed' handler asks unless the plugin says the copy is renewing it.
    p.copiedScanImages = async () => {
      if (!(p as unknown as { isRenewingCopiedNoteId(x: string): boolean }).isRenewingCopiedNoteId(late)) questions++;
      return 0;
    };
    (p.copiedExperiments as Set<string>).add(DIR);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect([...((p.copyIdsRenewed as Map<string, Set<string>>).get(DIR) ?? [])].sort()).toEqual([multi, renewedNote, none]);
    expect(questions).toBe(1);
    expect(makeCopyNewExperiment).not.toHaveBeenCalled();
  });

  // Codex v7l 2: a 'changed' for the refused note while the copy is still handled (here while
  // its scan images are counted) asks nothing and writes nothing more; it was said once.
  it('asks nothing about a refused note while the copy is handled', async () => {
    const multi = `${DIR}/001_WD010_A.labnote.md`, other = `${DIR}/002_WD010_B.labnote.md`;
    const scan = '---\nlabnote_id: |-\n  LN-AAAAAAAA\n---\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[a.jpg]]\n*a*\n';
    let warns = 0;
    const { p, folder, reassignCopiedId } = plugin(path => {
      if (path !== multi) return 'renewed';
      warns++;
      return 'refused';
    }, [multi, other], scan);
    let questions = 0;
    // barcodeFeature's 'changed' handler: unless the plugin covers it, it asks and re-numbers.
    p.copiedScanImages = async () => {
      if (!(p as unknown as { isRenewingCopiedNoteId(x: string): boolean }).isRenewingCopiedNoteId(multi)) {
        questions++;
        await (p.barcode as { reassignCopiedId(f: TFile): Promise<Status> }).reassignCopiedId(new TFile(multi));
      }
      return 0;
    };
    (p.copiedExperiments as Set<string>).add(DIR);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect(questions).toBe(0);
    expect(warns).toBe(1);
    expect(reassignCopiedId.mock.calls.filter(([f]) => f.path === multi)).toHaveLength(1);
  });

  // v7g: the same 'changed' said yes to while the copy is handled asks no question at all.
  it('asks no shared ID question while a copy with a refused note is handled', async () => {
    const multi = `${DIR}/001_WD010_A.labnote.md`;
    const scan = '---\nlabnote_id:\n  LN-AAAAAAAA\n---\n## Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=aa -->\n![[a.jpg]]\n*a*\n';
    const { p, folder } = plugin('refused', [multi], scan);
    const asked: boolean[] = [];
    p.copiedScanImages = async () => {
      asked.push(!(p as unknown as { isRenewingCopiedNoteId(x: string): boolean }).isRenewingCopiedNoteId(multi));
      return 0;
    };
    (p.copiedExperiments as Set<string>).add(DIR);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect(asked).toEqual([false]);
  });

  it.each<Status>(['renewed', 'none'])('a copied experiment goes on when the note ID is %s', async status => {
    const { p, folder, makeCopyNewExperiment } = plugin(status, [`${DIR}/001_WD010_A.labnote.md`]);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect([...((p.copyIdsRenewed as Map<string, Set<string>>).get(DIR) ?? [])]).toEqual([`${DIR}/001_WD010_A.labnote.md`]);
    expect(makeCopyNewExperiment).toHaveBeenCalledTimes(1);
  });
});

// A `- ` line at column 0 under a labnote_id with a value is a YAML error, not a value over
// several lines (L2): the real reassignCopiedId says what NoteIdService says (the front matter
// warning) and the copy flows go on as B7 did.
describe('copy flows and a copied note whose front matter cannot be read', () => {
  const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
  const text = (nl: string) => ['---', 'labnote_id: LN-7K3M9QX2', '- continued', 'created_date: 2020-01-01', '---', 'body', ''].join(nl);

  function real(nl: string, notes: string[]) {
    const made = plugin('renewed', notes, text(nl));
    const notices: { level: string; msg: string }[] = [];
    const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
    const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true, pick: async () => undefined, fs: { exists: async () => false } };
    const app = made.p.app as Record<string, unknown>;
    const barcode = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(barcode, { plugin: { app, host, t }, noteIds: new NoteIdService(app as never, host as never) });
    Object.assign(made.p, { host, t, barcode });
    return { ...made, notices, barcode };
  }

  it.each(endings)('reassignCopiedId fails without the L2 warning (%s)', async (_n, nl) => {
    const path = `${DIR}/001_WD010_A.labnote.md`;
    const { barcode, notices } = real(nl, [path]);
    expect(await barcode.reassignCopiedId(new TFile(path) as never)).toBe('failed');
    expect(notices).toEqual([{ level: 'warn', msg: expect.stringContaining(`Front matter of ${path} could not be read`) }]);
  });

  it.each(endings)('a copied workflow note goes on to its name and rename (%s)', async (_n, nl) => {
    const path = `${DIR}/001_WD010_A.labnote 1.md`;
    const { p, renameFile, list, notices } = real(nl, [path]);
    (p.copiedWorkflows as Set<string>).add(path);
    // The step right before the rename; its date reset is not what is tested here.
    const resetCopyDates = vi.fn(async () => {});
    p.resetCopyDates = resetCopyDates;
    await (p as unknown as { offerCopiedWorkflowFix(f: TFile): Promise<void> }).offerCopiedWorkflowFix(new TFile(path));
    expect(list).toHaveBeenCalled();
    expect(resetCopyDates).toHaveBeenCalledTimes(1);
    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(notices.filter(n => n.msg.includes('could not be written'))).toEqual([]);
    expect(notices.filter(n => n.msg.includes('could not be read'))).toHaveLength(1);
  });

  it.each(endings)('a copied experiment records the note and is made a new experiment (%s)', async (_n, nl) => {
    const path = `${DIR}/001_WD010_A.labnote.md`;
    const { p, folder, makeCopyNewExperiment, notices } = real(nl, [path]);
    (p.copiedExperiments as Set<string>).add(DIR);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect([...((p.copyIdsRenewed as Map<string, Set<string>>).get(DIR) ?? [])]).toEqual([path]);
    expect(makeCopyNewExperiment).toHaveBeenCalledTimes(1);
    expect(notices.filter(n => n.msg.includes('could not be written'))).toEqual([]);
    expect(notices.filter(n => n.msg.includes('could not be read'))).toHaveLength(1);
  });
});

// A labnote_id that cannot be written but that YAML reads as no note ID (a list, a mapping or
// a string that is no ID) is no ID the copy can share: as B7, the copy is handled as one without an ID and goes on,
// with nothing said. One that YAML reads as an ID (on the line below an empty first value)
// may be shared, so the copy still stops there with the L2 warning.
describe('copy flows and an unwritable labnote_id YAML reads as no ID', () => {
  const endings = [['LF', '\n'], ['CRLF', '\r\n']] as const;
  const shapes = [
    ['an indented list', ['labnote_id:', '  - LN-AAAAAAAA']],
    ['a "- " sequence', ['labnote_id:', '- LN-AAAAAAAA']],
    ['a mapping', ['labnote_id:', '  key: LN-AAAAAAAA']],
    // Strings, but no note ID (NoteIdService.idOf): 'LN-AAAAAAAA\n', 'LN-AAAAAAAA more', 'LN-A LN-B'.
    ['a literal block', ['labnote_id: |', '  LN-AAAAAAAA']],
    ['an open quote going on', ['labnote_id: "LN-AAAAAAAA', '  more"']],
    ['two lines below an empty first value', ['labnote_id:', '  LN-A', '  LN-B']],
  ] as const;
  const cases = shapes.flatMap(([name, id]) => endings.map(([n, nl]) => [name, n, id, nl] as const));
  const text = (id: readonly string[], nl: string) => ['---', ...id, 'created_date: 2020-01-01', '---', 'body', ''].join(nl);

  function real(md: string, notes: string[]) {
    const made = plugin('renewed', notes, md);
    const notices: { level: string; msg: string }[] = [];
    const t = (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s);
    const host = { notify: (level: string, msg: string) => notices.push({ level, msg }), t, confirm: async () => true, pick: async () => undefined, fs: { exists: async () => false } };
    const app = made.p.app as Record<string, unknown>;
    const barcode = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
    Object.assign(barcode, { plugin: { app, host, t }, noteIds: new NoteIdService(app as never, host as never) });
    Object.assign(made.p, { host, t, barcode });
    return { ...made, notices, barcode };
  }

  it.each(cases)('reassignCopiedId gives none and says nothing (%s, %s)', async (_s, _n, id, nl) => {
    const path = `${DIR}/001_WD010_A.labnote.md`;
    const { barcode, notices } = real(text(id, nl), [path]);
    expect(await barcode.reassignCopiedId(new TFile(path) as never)).toBe('none');
    expect(notices).toEqual([]);
  });

  it.each(cases)('a copied workflow note goes on to its name and rename (%s, %s)', async (_s, _n, id, nl) => {
    const path = `${DIR}/001_WD010_A.labnote 1.md`;
    const { p, renameFile, list, notices } = real(text(id, nl), [path]);
    (p.copiedWorkflows as Set<string>).add(path);
    const resetCopyDates = vi.fn(async () => {});
    p.resetCopyDates = resetCopyDates;
    await (p as unknown as { offerCopiedWorkflowFix(f: TFile): Promise<void> }).offerCopiedWorkflowFix(new TFile(path));
    expect(list).toHaveBeenCalled();
    expect(resetCopyDates).toHaveBeenCalledTimes(1);
    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(notices.filter(n => n.level === 'warn')).toEqual([]);
  });

  it.each(cases)('a copied experiment records the note and is made a new experiment (%s, %s)', async (_s, _n, id, nl) => {
    const path = `${DIR}/001_WD010_A.labnote.md`;
    const { p, folder, makeCopyNewExperiment, notices } = real(text(id, nl), [path]);
    (p.copiedExperiments as Set<string>).add(DIR);
    await (p as unknown as { offerCopiedExperimentFix(f: TFolder, o: string): Promise<void> }).offerCopiedExperimentFix(folder, '001_Orig');
    expect([...((p.copyIdsRenewed as Map<string, Set<string>>).get(DIR) ?? [])]).toEqual([path]);
    expect(makeCopyNewExperiment).toHaveBeenCalledTimes(1);
    expect(notices.filter(n => n.level === 'warn')).toEqual([]);
  });

  it.each(endings)('an ID on the line below an empty first value is still refused (%s)', async (_n, nl) => {
    const path = `${DIR}/001_WD010_A.labnote 1.md`;
    const { p, barcode, renameFile, notices } = real(text(['labnote_id:', '  LN-AAAAAAAA'], nl), [path]);
    expect(await barcode.reassignCopiedId(new TFile(path) as never)).toBe('refused');
    (p.copiedWorkflows as Set<string>).add(path);
    await (p as unknown as { offerCopiedWorkflowFix(f: TFile): Promise<void> }).offerCopiedWorkflowFix(new TFile(path));
    expect(renameFile).not.toHaveBeenCalled();
    expect(notices.filter(n => n.msg.includes('could not be written'))).toHaveLength(1);
  });
});
