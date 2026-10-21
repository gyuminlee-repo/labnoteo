/**
 * Finding notes by their `labnote_id`, and giving notes one.
 *
 * Lookups go through the metadata cache, so they cost nothing per scan. A note
 * copied outside Obsidian (file manager, git) keeps the original's ID; such
 * duplicates are reported once per session with an offer to give the newer
 * note its own ID.
 */
import { TFile, type App } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { listFiledScans, parseFrontMatterYaml } from '@labnoteo/core';
import { generateNoteId, isValidNoteId, NOTE_ID_KEY, readNoteId, setNoteId } from '@labnoteo/core/lib/noteId';
import { noteIdFromFiledScanEmbed } from '../scan/imageStore';

/**
 * The ID a note was printed under before its `labnote_id` line was lost, read
 * from the names of the scans filed in it; the most frequent when they differ.
 */
export function previousNoteIdFromScans(content: string): string | undefined {
  const counts = new Map<string, number>();
  for (const scan of listFiledScans(content)) {
    const id = noteIdFromFiledScanEmbed(scan.embed);
    if (id && isValidNoteId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [id, n] of counts) if (best === undefined || n > counts.get(best)!) best = id;
  return best;
}

export class NoteIdService {
  private readonly reported = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly host: LabnoteHost
  ) {}

  /** The note's ID as the metadata cache knows it. */
  idOf(file: TFile): string | undefined {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_ID_KEY];
    return isValidNoteId(value) ? value : undefined;
  }

  /** Every ID in the vault with the notes carrying it. */
  index(): Map<string, TFile[]> {
    const byId = new Map<string, TFile[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const id = this.idOf(file);
      if (!id) continue;
      const list = byId.get(id);
      if (list) list.push(file);
      else byId.set(id, [file]);
    }
    return byId;
  }

  filesWithId(id: string): TFile[] {
    return this.index().get(id) ?? [];
  }

  /**
   * The note's ID, giving it a fresh one first when it has none (or always,
   * with `reassign`). Undefined when the front matter cannot be read: writing
   * then could lose the other fields. Not a content change, so
   * `last_updated_date` stays as it is.
   */
  async ensureId(file: TFile, opts: { reassign?: boolean } = {}): Promise<string | undefined> {
    const content = (await this.app.vault.read(file)).replace(/\r\n/g, '\n');
    if (!opts.reassign) {
      const existing = readNoteId(content);
      if (existing) return existing;
    }
    const { parseError } = parseFrontMatterYaml(content);
    if (parseError) {
      this.host.notify(
        'warn',
        this.host.t(
          'Front matter of this note could not be read, so it was left unchanged. ' +
            'Fix the YAML and try again: {0}',
          parseError
        )
      );
      return undefined;
    }
    if (!opts.reassign) {
      const restored = await this.offerPreviousId(file, content);
      if (restored) return restored;
    }
    const taken = new Set(this.index().keys());
    let id = generateNoteId();
    while (taken.has(id)) id = generateNoteId();
    await this.app.vault.process(file, data => setNoteId(data, id));
    return id;
  }

  /**
   * A note without an ID whose filed scans name the ID it was printed under
   * (#236): offer that ID back, so worksheets already printed still find the
   * note. Resolves the restored ID, or undefined when a new one is to be made.
   */
  private async offerPreviousId(file: TFile, content: string): Promise<string | undefined> {
    const previous = previousNoteIdFromScans(content);
    if (!previous) return undefined;
    const holder = this.filesWithId(previous).find(f => f.path !== file.path);
    if (holder) {
      this.host.notify(
        'warn',
        this.host.t(
          'The scans in this note are named after the note ID {0}, but {1} has that ID now, so this note gets a new one. Worksheets printed as {0} are filed in {1}.',
          previous,
          holder.path
        )
      );
      return undefined;
    }
    const ok = await this.host.confirm(
      this.host.t(
        'This note has no labnote_id, but its scans show it was printed as {0}. Restore that ID? With a new ID, worksheets already printed will not find this note.',
        previous
      ),
      { confirmLabel: this.host.t('Restore ID') }
    );
    if (!ok) return undefined;
    await this.app.vault.process(file, data => setNoteId(data, previous));
    return previous;
  }

  /**
   * IDs carried by several notes that were not reported yet this session,
   * each with the note to re-number: the most recently created one.
   */
  unreportedDuplicates(): { id: string; files: TFile[]; newest: TFile }[] {
    const out: { id: string; files: TFile[]; newest: TFile }[] = [];
    for (const [id, files] of this.index()) {
      if (files.length < 2 || this.reported.has(id)) continue;
      this.reported.add(id);
      const newest = files.reduce((a, b) => (b.stat.ctime > a.stat.ctime ? b : a));
      out.push({ id, files, newest });
    }
    return out;
  }

  /** Ask about each newly found duplicate ID, one at a time. */
  async offerDuplicateFixes(): Promise<void> {
    for (const { id, files, newest } of this.unreportedDuplicates()) {
      const ok = await this.host.confirm(
        this.host.t(
          'Notes {0} share the note ID {1}, probably because one was copied. Scans of either note would be filed in the wrong one. Give {2} a new ID?',
          files.map(f => f.path).join(', '),
          id,
          newest.path
        ),
        { confirmLabel: this.host.t('Give a new ID') }
      );
      if (!ok || !(this.app.vault.getAbstractFileByPath(newest.path) instanceof TFile)) continue;
      const next = await this.ensureId(newest, { reassign: true });
      if (next) this.host.notify('info', this.host.t('{0} now has the note ID {1}.', newest.basename, next));
    }
  }
}
