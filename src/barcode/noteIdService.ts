/**
 * Finding notes by their `labnote_id`, and giving notes one.
 *
 * Lookups go through the metadata cache, so they cost nothing per scan. A note
 * copied outside Obsidian (file manager, git) keeps the original's ID; such
 * duplicates are reported once per session and set of notes, with an offer to
 * give the newer note its own ID. Only lab notes count: a template or other
 * Markdown file carrying an ID is named in a warning instead (#426).
 */
import { TFile, type App } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import { listFiledScans, parseFrontMatterYaml } from '@labnoteo/core';
import { generateNoteId, isValidNoteId, NOTE_ID_KEY, readNoteId, setNoteId } from '@labnoteo/core/lib/noteId';
import { noteIdFromFiledScanEmbed } from '../scan/imageStore';

/** Notes that get a barcode: lab notes (`*.labnote.md`). */
export const isBarcodeNote = (path: string): boolean => path.toLowerCase().endsWith('.labnote.md');

const duplicateKey = (id: string, files: readonly TFile[]): string =>
  `${id}\n${files
    .map(f => f.path)
    .sort()
    .join('\n')}`;

const newestOf = (files: readonly TFile[]): TFile => files.reduce((a, b) => (b.stat.ctime > a.stat.ctime ? b : a));

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
  /** Duplicates already asked about, by ID and the notes sharing it (#425). */
  private readonly reported = new Set<string>();
  private readonly warnedOutsideLabNotes = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly host: LabnoteHost
  ) {}

  /** The note's ID as the metadata cache knows it. */
  idOf(file: TFile): string | undefined {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_ID_KEY];
    return isValidNoteId(value) ? value : undefined;
  }

  /**
   * Every ID in the vault with the lab notes carrying it. Other Markdown files
   * (an Obsidian template made from a lab note, say) are left out, with
   * `outsideLabNotes`: they are never printed, so a scan cannot be meant for them.
   */
  index(opts: { outsideLabNotes?: boolean } = {}): Map<string, TFile[]> {
    const byId = new Map<string, TFile[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isBarcodeNote(file.path) === !!opts.outsideLabNotes) continue;
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

  /** Markdown files other than lab notes that carry `id`. */
  filesOutsideLabNotesWithId(id: string): TFile[] {
    return this.index({ outsideLabNotes: true }).get(id) ?? [];
  }

  /**
   * The note's ID, giving it a fresh one first when it has none (or always,
   * with `reassign`). Undefined when the front matter cannot be read (writing
   * then could lose the other fields) or when the user cancelled the offer to
   * restore an earlier ID. Not a content change, so `last_updated_date` stays
   * as it is.
   */
  async ensureId(file: TFile, opts: { reassign?: boolean } = {}): Promise<string | undefined> {
    return (await this.ensureIdResult(file, opts)).id;
  }

  /** {@link ensureId}, saying why no ID came back. */
  async ensureIdResult(
    file: TFile,
    opts: { reassign?: boolean } = {}
  ): Promise<{ id: string; reason?: undefined } | { id?: undefined; reason: 'unreadable' | 'cancelled' }> {
    const content = (await this.app.vault.read(file)).replace(/\r\n/g, '\n');
    if (!opts.reassign) {
      const existing = readNoteId(content);
      if (existing) return { id: existing };
    }
    const { parseError } = parseFrontMatterYaml(content);
    if (parseError) {
      this.host.notify(
        'warn',
        this.host.t(
          'Front matter of {0} could not be read, so it was left unchanged. Fix the YAML and try again: {1}',
          file.path,
          parseError
        )
      );
      return { reason: 'unreadable' };
    }
    if (!opts.reassign) {
      const offer = await this.offerPreviousId(file, content);
      if (offer.choice === 'restored') return { id: offer.id };
      if (offer.choice === 'cancelled') return { reason: 'cancelled' };
    }
    const taken = new Set([...this.index().keys(), ...this.index({ outsideLabNotes: true }).keys()]);
    let id = generateNoteId();
    while (taken.has(id)) id = generateNoteId();
    await this.app.vault.process(file, data => setNoteId(data, id));
    return { id };
  }

  /**
   * A note without an ID whose filed scans name the ID it was printed under
   * (#236): offer that ID back, so worksheets already printed still find the
   * note. A new ID is a choice of its own, so closing the question changes
   * nothing and it is asked again next time (#267).
   */
  private async offerPreviousId(
    file: TFile,
    content: string
  ): Promise<{ choice: 'restored'; id: string } | { choice: 'new' | 'cancelled' }> {
    const previous = previousNoteIdFromScans(content);
    if (!previous) return { choice: 'new' };
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
      return { choice: 'new' };
    }
    const choice = await this.host.pick<'restore' | 'new' | 'cancel'>(
      [
        { label: this.host.t('Restore ID'), description: previous, value: 'restore' },
        { label: this.host.t('Give a new ID'), value: 'new' },
        { label: this.host.t('Cancel'), value: 'cancel' },
      ],
      {
        title: this.host.t(
          'This note has no labnote_id, but its scans show it was printed as {0}. Restore that ID? With a new ID, worksheets already printed will not find this note.',
          previous
        ),
      }
    );
    if (choice === 'new') return { choice: 'new' };
    if (choice !== 'restore') return { choice: 'cancelled' };
    await this.app.vault.process(file, data => setNoteId(data, previous));
    return { choice: 'restored', id: previous };
  }

  /**
   * IDs carried by several lab notes whose set of notes was not reported yet
   * this session, each with the note to re-number: the most recently created
   * one. A note joining a reported set makes it a new one (#425).
   */
  unreportedDuplicates(): { id: string; files: TFile[]; newest: TFile }[] {
    const out: { id: string; files: TFile[]; newest: TFile }[] = [];
    for (const [id, files] of this.index()) {
      if (files.length < 2 || this.reported.has(duplicateKey(id, files))) continue;
      this.reported.add(duplicateKey(id, files));
      out.push({ id, files, newest: newestOf(files) });
    }
    return out;
  }

  /** True when another lab note or a Markdown file outside lab notes carries the note's ID. */
  sharesId(file: TFile): boolean {
    const id = this.idOf(file);
    if (!id) return false;
    return this.filesWithId(id).length > 1 || this.filesOutsideLabNotesWithId(id).length > 0;
  }

  /**
   * Ask about each newly found duplicate ID, one at a time, and again about
   * the notes left sharing it after one was re-numbered (#425).
   */
  async offerDuplicateFixes(): Promise<void> {
    this.warnIdsOutsideLabNotes();
    for (const dup of this.unreportedDuplicates()) {
      let files = dup.files;
      while (files.length > 1) {
        const newest = files === dup.files ? dup.newest : newestOf(files);
        this.reported.add(duplicateKey(dup.id, files));
        const ok = await this.host.confirm(
          this.host.t(
            'Notes {0} share the note ID {1}, probably because one was copied. Scans of either note would be filed in the wrong one. Give {2} a new ID?',
            files.map(f => f.path).join(', '),
            dup.id,
            newest.path
          ),
          { confirmLabel: this.host.t('Give a new ID') }
        );
        if (!ok) break;
        if (this.app.vault.getAbstractFileByPath(newest.path) instanceof TFile) {
          const next = await this.ensureId(newest, { reassign: true });
          if (!next) break;
          this.host.notify('info', this.host.t('{0} now has the note ID {1}.', newest.basename, next));
        }
        files = files.filter(f => f.path !== newest.path);
      }
    }
  }

  /**
   * A template or other Markdown file sharing a lab note's ID hands it to every
   * note made from it, and re-numbering the file only moves the clash (#426).
   */
  private warnIdsOutsideLabNotes(): void {
    const labIds = this.index();
    for (const [id, files] of this.index({ outsideLabNotes: true })) {
      if (!labIds.has(id)) continue;
      for (const file of files) {
        const key = `${id}\n${file.path}`;
        if (this.warnedOutsideLabNotes.has(key)) continue;
        this.warnedOutsideLabNotes.add(key);
        this.host.notify(
          'warn',
          this.host.t(
            '{0} is not a lab note but carries the note ID {1}, so notes made from it as a template get that ID too. Delete its labnote_id line.',
            file.path,
            id
          )
        );
      }
    }
  }
}
