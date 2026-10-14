/**
 * Export every Markdown table in a lab note to sibling `.csv` files.
 *
 * Reuses the pure core helpers ({@link extractMarkdownTables},
 * {@link tableToCsv}); this module only handles vault I/O and user feedback.
 */
import { Notice, TFile } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import { extractMarkdownTables, tableToCsv } from '@labnoteo/core/lib/exportTablesCsv';
import { staleTableCsvs } from '@labnoteo/core/lib/workflowStructure';
import { confirmModal } from './modals';
import { listFileNames, trashTableCsvs } from './commands';
import type LabnotePlugin from './main';

/** Strip the trailing `.md` (keeps a compound `.labnote` stem). */
function noteStem(file: TFile): string {
  return file.name.replace(/\.md$/i, '');
}

/**
 * Offer to trash the CSVs of tables the note no longer has (#74). Returns the
 * feedback to append to the export notice, or '' when there were none.
 */
async function offerStaleCsvCleanup(plugin: LabnotePlugin, file: TFile, tableCount: number): Promise<string> {
  const dir = posix.dirname(file.path);
  const stale = staleTableCsvs(file.name, await plugin.fs.list(dir), tableCount);
  if (stale.length === 0) return '';
  const ok = await confirmModal(
    plugin.app,
    plugin.t(
      'These table CSV files no longer match a table in the note. Move them to the trash?\n\n{0}',
      listFileNames(plugin, stale)
    ),
    plugin.t('Move to trash')
  );
  if (!ok) return plugin.t('{0} old CSV file(s) kept.', String(stale.length));
  const kept = await trashTableCsvs(plugin.app, dir, stale);
  const moved = plugin.t('{0} CSV file(s) moved to the trash.', String(stale.length - kept));
  return kept > 0 ? `${moved} ${plugin.t('{0} old CSV file(s) kept.', String(kept))}` : moved;
}

export async function exportTablesToCsv(plugin: LabnotePlugin, file: TFile): Promise<void> {
  const content = await plugin.app.vault.read(file);
  const tables = extractMarkdownTables(content);
  if (tables.length === 0) {
    const cleanup = await offerStaleCsvCleanup(plugin, file, 0);
    new Notice([plugin.t('No tables found in this note.'), cleanup].filter(Boolean).join(' '));
    return;
  }

  const dir = posix.dirname(file.path);
  const stem = noteStem(file);
  let written = 0;
  for (const table of tables) {
    const outPath = posix.join(dir, `${stem}_table${table.index + 1}.csv`);
    await plugin.fs.write(outPath, tableToCsv(table.rows, { bom: true }));
    written++;
  }

  const cleanup = await offerStaleCsvCleanup(plugin, file, tables.length);
  new Notice([plugin.t('Exported {0} CSV file(s).', String(written)), cleanup].filter(Boolean).join(' '));
}

/** Export tables from the currently active markdown note (command palette). */
export async function exportActiveNoteTablesToCsv(plugin: LabnotePlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file || file.extension !== 'md') {
    new Notice(plugin.t('Open a markdown note first.'));
    return;
  }
  await exportTablesToCsv(plugin, file);
}
