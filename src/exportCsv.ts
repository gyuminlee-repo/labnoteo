/**
 * Export every Markdown table in a lab note to sibling `.csv` files.
 *
 * Reuses the pure core helpers ({@link extractMarkdownTables},
 * {@link tableToCsv}); this module only handles vault I/O and user feedback.
 */
import { Notice, TFile } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import {
  classifyCsvOverwrites,
  csvRowCount,
  extractMarkdownTables,
  firstDifferingRow,
  tableToCsv,
  type CsvOverwriteKind,
} from '@labnoteo/core/lib/exportTablesCsv';
import { siblingTableCsvs, staleTableCsvs } from '@labnoteo/core/lib/workflowStructure';
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
  const outputs = await Promise.all(
    tables.map(async table => {
      const path = posix.join(dir, `${stem}_table${table.index + 1}.csv`);
      const csv = tableToCsv(table.rows, { bom: true });
      const old = (await plugin.fs.exists(path)) ? normalizeCsv(await plugin.fs.read(path)) : undefined;
      return { path, csv, fresh: normalizeCsv(csv), old };
    })
  );
  // `a → a` says nothing when two tables share a header: show what differs (#110).
  const sameHeaderHint = (old: string, fresh: string): string => {
    if (firstLine(old) !== firstLine(fresh)) return '';
    const before = csvRowCount(old);
    const after = csvRowCount(fresh);
    if (before !== after) return ` (${plugin.t('{0} rows → {1} rows', String(before), String(after))})`;
    const diff = firstDifferingRow(old, fresh);
    return diff
      ? ` (${plugin.t('row {0}: {1} → {2}', String(diff.row), clip(diff.from), clip(diff.to))})`
      : '';
  };
  const siblings = await plugin.fs.list(dir);
  const existingCount = Math.max(
    0,
    ...siblingTableCsvs(file.name, siblings).map(f => Number(/_table(\d+)\.csv$/.exec(f)![1]))
  );
  const staleOld = await Promise.all(
    staleTableCsvs(file.name, siblings, tables.length).map(async name =>
      normalizeCsv(await plugin.fs.read(posix.join(dir, name)))
    )
  );
  const kinds = classifyCsvOverwrites(outputs, existingCount, staleOld);

  const listOf = (kind: CsvOverwriteKind) =>
    outputs
      .filter((_, k) => kinds[k] === kind)
      .map(
        o =>
          `- ${posix.basename(o.path)}: ${firstLine(o.old!)} → ${firstLine(o.fresh)}${sameHeaderHint(o.old!, o.fresh)}`
      )
      .join('\n');
  const sections: string[] = [];
  const moved = listOf('moved');
  if (moved) {
    sections.push(
      plugin.t(
        'These CSV files would now hold a different table (a table was added, removed or moved). Overwrite them?\n\n{0}',
        moved
      )
    );
  }
  const headerChanged = listOf('headerChanged');
  if (headerChanged) {
    sections.push(plugin.t('The header of these CSV files changed. Overwrite them?\n\n{0}', headerChanged));
  }
  if (sections.length > 0) {
    const ok = await confirmModal(plugin.app, sections.join('\n\n'), plugin.t('Overwrite'));
    if (!ok) {
      new Notice(plugin.t('No changes made.'));
      return;
    }
  }

  let written = 0;
  for (const o of outputs) {
    if (o.old === o.fresh) continue;
    await plugin.fs.write(o.path, o.csv);
    written++;
  }

  const unchanged = outputs.length - written;
  const exported =
    written === 0
      ? plugin.t('The CSV files are already up to date ({0}).', String(outputs.length))
      : unchanged > 0
        ? plugin.t('Exported {0} CSV file(s) ({1} unchanged file(s) left as they were).', String(written), String(unchanged))
        : plugin.t('Exported {0} CSV file(s).', String(written));
  const cleanup = await offerStaleCsvCleanup(plugin, file, tables.length);
  new Notice([exported, cleanup].filter(Boolean).join(' '));
}

/** CSV text without the BOM and CRLF a re-save in Excel may add or drop. */
function normalizeCsv(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** The header row of a CSV as shown in the overwrite prompt, cut when long. */
function firstLine(csv: string): string {
  return clip(csv.split('\n', 1)[0]);
}

/** A CSV line as shown in the overwrite prompt, cut when long. */
function clip(line: string): string {
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
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
