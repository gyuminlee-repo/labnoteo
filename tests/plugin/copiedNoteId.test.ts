/**
 * L2: a copied note whose labnote_id cannot be written (over several lines) is said once by
 * BarcodeFeature.reassignCopiedId ('refused'); the copy flows then go no further with it.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile, TFolder } from '../stubs/obsidian';
import LabnotePlugin from '../../src/main';

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

type Status = 'renewed' | 'none' | 'refused';
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
