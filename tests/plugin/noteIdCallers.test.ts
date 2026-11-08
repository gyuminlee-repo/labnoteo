/**
 * Every path that reads a labnote_id: the five callers, for the six values written over
 * several lines, LF and CRLF, with each answer to the ID question (pick: none, 'new',
 * 'restore'). Each cell holds what the plugin does and says how that stands to 0.140.2:
 * the same as 0.140.2, or which L2 allowance it falls under:
 *   - L2 write refusal: 0.140.2 writes and breaks the value; it is left as it is, with the L2 warning.
 *   - copy or move warning: a copy or a scan move whose ID YAML reads; said, not passed over.
 *   - user command warning: printing, showBarcode or Assign note ID; warned before any question,
 *     since every answer that writes would break the value.
 * A plain value on the key line with a line below it (plainCont) is read and written on that
 * line as 0.140.2 does, by every caller alike: each plainCont cell is the same as 0.140.2.
 */
import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from '../stubs/obsidian';
import { parseFrontMatterYaml } from '../../packages/labnoteo-core/src/sections/frontMatter';
import { BarcodeFeature } from '../../src/barcode/barcodeFeature';
import { NoteIdService } from '../../src/barcode/noteIdService';

const shapes: Record<string, string[]> = {
  plainCont: ['labnote_id: LN-7K3M9QX2', '  more'],
  literal: ['labnote_id: |', '  LN-7K3M9QX2'],
  quotedCont: ['labnote_id: "LN-7K3M9QX2', '  more"'],
  emptyThenTwo: ['labnote_id:', '  LN-7K3M9QX2', '  more'],
  folded: ['labnote_id: >-', '  LN-7K3M9QX2'],
  emptyThenId: ['labnote_id:', '  LN-7K3M9QX2'],
};
const NOTE = 'labnote/002_B/001_WD010_A.labnote.md';
const SCANS = 'labnote/001_A/images/scans';
const IMG = `${SCANS}/LN-7K3M9QX2_u1_p1_2026-01-01.jpg`;
// A new ID is random: every other ID reads as LN-NEW.
const norm = (s: unknown): string => JSON.stringify(s ?? null).replace(/LN-(?!7K3M9QX2)[0-9A-Z]{8}/g, 'LN-NEW');

function setup(text: string, pick: string) {
  const files = new Map<string, string>([[NOTE, text]]);
  const img = new TFile(IMG);
  const scans = Object.assign(new TFolder(), { path: SCANS, name: 'scans', children: [img] });
  const renames: string[] = [];
  const notices: string[] = [];
  const app = {
    vault: {
      read: async (f: TFile) => files.get(f.path)!,
      process: async (f: TFile, fn: (s: string) => string) => { files.set(f.path, fn(files.get(f.path)!)); },
      getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : p === SCANS ? scans : p === IMG ? img : null),
      getMarkdownFiles: () => [...files.keys()].map(p => new TFile(p)),
      createFolder: async () => {},
    },
    fileManager: { renameFile: async (f: TFile, to: string) => { renames.push(`${f.path}->${to}`); } },
    // As Obsidian reads the front matter.
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: parseFrontMatterYaml(files.get(f.path)!.replace(/\r\n/g, '\n')).frontMatter }) },
  };
  const t = (s: string, ...a: unknown[]) => a.reduce<string>((o, x, i) => o.replace(`{${i}}`, String(x)), s);
  const host = {
    notify: (level: string, msg: string) => notices.push(`${level}:${msg.slice(0, 50)}`),
    t,
    confirm: async () => true,
    pick: async () => (pick === 'none' ? undefined : pick),
    fs: { exists: async () => false },
  };
  const feat = Object.create(BarcodeFeature.prototype) as BarcodeFeature;
  Object.assign(feat, { plugin: { app, host, t }, noteIds: new NoteIdService(app as never, host as never) });
  return { feat, files, renames, notices, file: new TFile(NOTE) };
}

const ops: Record<string, (x: ReturnType<typeof setup>) => Promise<unknown>> = {
  ensureId: x => x.feat.noteIds.ensureId(x.file as never),
  ensureIdReassign: x => x.feat.noteIds.ensureId(x.file as never, { reassign: true }),
  assignId: x => (x.feat as unknown as { assignId(f: TFile): Promise<void> }).assignId(x.file),
  reassignCopiedId: x => x.feat.reassignCopiedId(x.file as never),
  moveScansWithNote: x => x.feat.moveScansWithNote(NOTE, 'labnote/001_A', 'labnote/002_B'),
};

// [caller, shape, line ends, pick, how it stands to 0.140.2, what it does now (r: result, wrote: the
// note after or 'no', renames: scans moved, notices)]
const cells: [string, string, string, string, string, string][] = [
  ['ensureId', 'plainCont', 'LF', 'none', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'plainCont', 'CRLF', 'none', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'literal', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'literal', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'plainCont', 'LF', 'none', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'plainCont', 'CRLF', 'none', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'literal', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'literal', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'plainCont', 'LF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'plainCont', 'CRLF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'literal', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'literal', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'LF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'CRLF', 'none', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'LF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'CRLF', 'none', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'plainCont', 'LF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'plainCont', 'CRLF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'literal', 'LF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'literal', 'CRLF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'LF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'CRLF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'LF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'CRLF', 'none', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'folded', 'LF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'folded', 'CRLF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'LF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'CRLF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'plainCont', 'LF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'plainCont', 'CRLF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'literal', 'LF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'literal', 'CRLF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'LF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'CRLF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'LF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'CRLF', 'none', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'folded', 'LF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'folded', 'CRLF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'LF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'CRLF', 'none', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'plainCont', 'LF', 'new', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'plainCont', 'CRLF', 'new', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'literal', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'literal', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'plainCont', 'LF', 'new', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'plainCont', 'CRLF', 'new', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'literal', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'literal', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'plainCont', 'LF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'plainCont', 'CRLF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'literal', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'literal', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'LF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'CRLF', 'new', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'plainCont', 'LF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'plainCont', 'CRLF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'literal', 'LF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'literal', 'CRLF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'LF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'CRLF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'LF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'CRLF', 'new', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'folded', 'LF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'folded', 'CRLF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'LF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'CRLF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'plainCont', 'LF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'plainCont', 'CRLF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'literal', 'LF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'literal', 'CRLF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'LF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'CRLF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'LF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'CRLF', 'new', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'folded', 'LF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'folded', 'CRLF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'LF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'CRLF', 'new', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'plainCont', 'LF', 'restore', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'plainCont', 'CRLF', 'restore', 'as 0.140.2 does', "{\"r\":\"LN-7K3M9QX2\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['ensureId', 'literal', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'literal', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'quotedCont', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenTwo', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'folded', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureId', 'emptyThenId', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'plainCont', 'LF', 'restore', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'plainCont', 'CRLF', 'restore', 'as 0.140.2 does', "{\"r\":\"LN-NEW\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[]}"],
  ['ensureIdReassign', 'literal', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'literal', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'quotedCont', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenTwo', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'folded', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['ensureIdReassign', 'emptyThenId', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'plainCont', 'LF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'plainCont', 'CRLF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"info:This note already has the note ID LN-7K3M9QX2.\"]}"],
  ['assignId', 'literal', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'literal', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'quotedCont', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenTwo', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'LF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'folded', 'CRLF', 'restore', 'user command warning', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'LF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['assignId', 'emptyThenId', 'CRLF', 'restore', 'L2 write refusal', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'plainCont', 'LF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\ntitle: x\\nlabnote_id: LN-NEW\\n  more\\n---\\nbody\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'plainCont', 'CRLF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"renewed\",\"wrote\":\"---\\r\\ntitle: x\\r\\nlabnote_id: LN-NEW\\r\\n  more\\r\\n---\\r\\nbody\\r\\n\",\"renames\":0,\"notices\":[\"info:Gave the copy 001_WD010_A.labnote its own note ID \"]}"],
  ['reassignCopiedId', 'literal', 'LF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'literal', 'CRLF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'LF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'quotedCont', 'CRLF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'LF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'emptyThenTwo', 'CRLF', 'restore', 'as 0.140.2 does, which returns nothing', "{\"r\":\"none\",\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['reassignCopiedId', 'folded', 'LF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'folded', 'CRLF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'LF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['reassignCopiedId', 'emptyThenId', 'CRLF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'plainCont', 'LF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'plainCont', 'CRLF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":1,\"notices\":[\"info:Moved 1 scan image(s) to labnote/002_B/images/scan\"]}"],
  ['moveScansWithNote', 'literal', 'LF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'literal', 'CRLF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'LF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'quotedCont', 'CRLF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'LF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'emptyThenTwo', 'CRLF', 'restore', 'as 0.140.2 does', "{\"wrote\":\"no\",\"renames\":0,\"notices\":[]}"],
  ['moveScansWithNote', 'folded', 'LF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'folded', 'CRLF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'LF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
  ['moveScansWithNote', 'emptyThenId', 'CRLF', 'restore', 'copy or move warning', "{\"r\":\"refused\",\"wrote\":\"no\",\"renames\":0,\"notices\":[\"warn:The labnote_id of labnote/002_B/001_WD010_A.labnot\"]}"],
];

describe('the callers reading a labnote_id over several lines', () => {
  it.each(cells)('%s, %s, %s, pick %s: %s', async (op, shape, n, pick, _standing, expected) => {
    const nl = n === 'LF' ? '\n' : '\r\n';
    const text = ['---', 'title: x', ...shapes[shape], '---', 'body', ''].join(nl);
    const x = setup(text, pick);
    const r = await ops[op](x);
    const after = x.files.get(NOTE)!;
    expect(norm({ r, wrote: after === text ? 'no' : after, renames: x.renames.length, notices: x.notices })).toBe(expected);
  });
});
