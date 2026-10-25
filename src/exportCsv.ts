/**
 * Export every Markdown table in a lab note to sibling `.csv` files.
 *
 * Reuses the pure core helpers ({@link scanMarkdownTables},
 * {@link tableToCsv}); this module only handles vault I/O and user feedback.
 */
import { Notice, TFile } from 'obsidian';
import * as posix from '@labnoteo/core/posix';
import {
  classifyCsvOverwrites,
  csvRowCount,
  excelRiskCells,
  firstDifferingRow,
  scanMarkdownTables,
  tableToCsv,
  type CsvOverwriteKind,
  type ExcelRiskCell,
  type ExcelRiskKind,
} from '@labnoteo/core/lib/exportTablesCsv';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { EXCEL_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import {
  orphanTableCsvs,
  planTableCsvNames,
  siblingTableCsvs,
  staleTableCsvs,
} from '@labnoteo/core/lib/workflowStructure';
import { confirmModal } from './modals';
import { listFileNames, trashTableCsvs, windowsPathsOver } from './commands';
import type LabnotePlugin from './main';

/** One table's CSV: where it goes, what is written, and the CSV already there (BOM and CRLF dropped). */
interface CsvOutput {
  path: string;
  csv: string;
  fresh: string;
  old?: string;
  /** The table's header row, and the cells Excel would change (#375). */
  header: string[];
  risky: ExcelRiskCell[];
}

/** A note's tables as CSVs, worked out before anything is written. */
interface NoteCsvPlan {
  file: TFile;
  dir: string;
  /** Tables left out: no blank line above them, or inside a comment. */
  notRendered: number;
  hidden: number;
  outputs: CsvOutput[];
  renames: ReadonlyArray<{ from: string; to: string }>;
  /** Overwrite prompt lines: CSVs that would hold another table, and CSVs whose header changed. */
  moved: string[];
  headerChanged: string[];
}

async function planNoteCsvExport(plugin: LabnotePlugin, file: TFile): Promise<NoteCsvPlan> {
  const content = await plugin.app.vault.read(file);
  const { tables, notRendered, hidden } = scanMarkdownTables(content);
  const dir = posix.dirname(file.path);
  const plan: NoteCsvPlan = {
    file,
    dir,
    notRendered,
    hidden,
    outputs: [],
    renames: [],
    moved: [],
    headerChanged: [],
  };
  if (tables.length === 0) return plan;

  const siblings = await plugin.fs.list(dir);
  const names = planTableCsvNames(file.name, siblings, tables.length);
  const renamedFrom = new Map(names.renames.map(r => [r.to, r.from]));
  const outputs = await Promise.all(
    tables.map(async table => {
      const name = names.names[table.index];
      const path = posix.join(dir, name);
      // A CSV still to be renamed holds the old content of this table.
      const current = posix.join(dir, renamedFrom.get(name) ?? name);
      const csv = tableToCsv(table.rows, { bom: true });
      const old = (await plugin.fs.exists(current)) ? normalizeCsv(await plugin.fs.read(current)) : undefined;
      return { path, csv, fresh: normalizeCsv(csv), old, header: table.rows[0] ?? [], risky: excelRiskCells(table.rows) };
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
  const existingCount = Math.max(
    0,
    ...siblingTableCsvs(file.name, siblings).map(f => Number(/_table(\d+)\.csv$/.exec(f)![1]))
  );
  const staleOld = await Promise.all(
    names.stale.map(async name => normalizeCsv(await plugin.fs.read(posix.join(dir, name))))
  );
  const kinds = classifyCsvOverwrites(outputs, existingCount, staleOld);
  const linesOf = (kind: CsvOverwriteKind) =>
    outputs
      .filter((_, k) => kinds[k] === kind)
      .map(
        o =>
          `- ${posix.basename(o.path)}: ${firstLine(o.old!)} → ${firstLine(o.fresh)}${sameHeaderHint(o.old!, o.fresh)}`
      );
  return { ...plan, outputs, renames: names.renames, moved: linesOf('moved'), headerChanged: linesOf('headerChanged') };
}

/** Ask once before overwriting CSVs that would change table or header; true when there is nothing to ask. */
async function confirmOverwrites(plugin: LabnotePlugin, plans: readonly NoteCsvPlan[]): Promise<boolean> {
  const sections: string[] = [];
  const moved = plans.flatMap(p => p.moved).join('\n');
  if (moved) {
    sections.push(
      plugin.t(
        'These CSV files would now hold a different table (a table was added, removed or moved). Overwrite them?\n\n{0}',
        moved
      )
    );
  }
  const headerChanged = plans.flatMap(p => p.headerChanged).join('\n');
  if (headerChanged) {
    sections.push(plugin.t('The header of these CSV files changed. Overwrite them?\n\n{0}', headerChanged));
  }
  if (sections.length === 0) return true;
  return confirmModal(plugin.app, sections.join('\n\n'), plugin.t('Overwrite'), { destructive: true });
}

interface CsvWriteResult {
  written: number;
  renamed: string[];
  notRenamed: number;
}

async function writeNoteCsvExport(plugin: LabnotePlugin, plan: NoteCsvPlan): Promise<CsvWriteResult> {
  // Renamed before writing: the new name must be free when the CSV moves to it.
  const renamed: string[] = [];
  const notRenamed = new Set<string>();
  for (const r of plan.renames) {
    const csvFile = plugin.app.vault.getFileByPath(posix.join(plan.dir, r.from));
    try {
      if (!(csvFile instanceof TFile)) throw new Error(`${r.from} is not in the vault index`);
      await plugin.app.fileManager.renameFile(csvFile, posix.join(plan.dir, r.to));
      renamed.push(`${r.from} → ${r.to}`);
    } catch (err) {
      console.warn('[labnoteo] could not rename table CSV:', err);
      notRenamed.add(r.to);
    }
  }

  let written = 0;
  for (const o of plan.outputs) {
    if (o.old === o.fresh && !notRenamed.has(posix.basename(o.path))) continue;
    await plugin.fs.write(o.path, o.csv);
    written++;
  }
  return { written, renamed, notRenamed: notRenamed.size };
}

/** CSVs named after `file` that no longer match one of its `tableCount` tables (#74). */
async function staleCsvsOf(plugin: LabnotePlugin, file: TFile, tableCount: number): Promise<string[]> {
  return staleTableCsvs(file.name, await plugin.fs.list(posix.dirname(file.path)), tableCount);
}

/** The lab note CSVs in `dir` whose note is gone (#374). */
async function orphanCsvsIn(plugin: LabnotePlugin, dir: string): Promise<string[]> {
  return orphanTableCsvs(await plugin.fs.list(dir));
}

/**
 * Offer to trash the CSVs in `dir` of tables the notes no longer have (#74),
 * and those whose note is gone (#374). `notes` says whether more than one
 * note was exported, for the wording (#370). Returns the feedback to append
 * to the export notice, or '' when there were none.
 */
async function offerStaleCsvCleanup(
  plugin: LabnotePlugin,
  dir: string,
  stale: readonly string[],
  orphans: readonly string[] = [],
  notes: 'one' | 'many' = 'one'
): Promise<string> {
  const total = stale.length + orphans.length;
  if (total === 0) return '';
  const sections = [
    stale.length > 0
      ? plugin.t(
          notes === 'one'
            ? 'These table CSV files no longer match a table in the note. Move them to the trash?\n\n{0}'
            : 'These table CSV files no longer match a table in their notes. Move them to the trash?\n\n{0}',
          listFileNames(plugin, stale)
        )
      : '',
    orphans.length > 0
      ? plugin.t(
          'These table CSV files have no note of their name in the folder: the note was deleted, or renamed while a CSV of its new name was there. Move them to the trash?\n\n{0}',
          listFileNames(plugin, orphans)
        )
      : '',
  ].filter(Boolean);
  const ok = await confirmModal(plugin.app, sections.join('\n\n'), plugin.t('Move to trash'), { destructive: true });
  if (!ok) return plugin.t('{0} old CSV file(s) kept.', String(total));
  const kept = await trashTableCsvs(plugin.app, dir, [...stale, ...orphans]);
  const moved = plugin.t('{0} CSV file(s) moved to the trash.', String(total - kept));
  return kept > 0 ? `${moved} ${plugin.t('{0} old CSV file(s) kept.', String(kept))}` : moved;
}

/** The name a note goes by in the notices: `001_WT020_A` for `001_WT020_A.labnote.md`. */
function noteLabel(file: TFile): string {
  return file.name.replace(/(?:\.labnote)?\.md$/i, '');
}

/**
 * Why some tables were left out, or ''. With `plans` of several notes, each
 * reason names the notes it applies to (#370).
 */
function skippedText(plugin: LabnotePlugin, plans: readonly NoteCsvPlan[]): string {
  const notRendered = plans.reduce((n, p) => n + p.notRendered, 0);
  const hidden = plans.reduce((n, p) => n + p.hidden, 0);
  const where = (count: (p: NoteCsvPlan) => number): string =>
    plans.length > 1
      ? ` ${plugin.t(
          'In: {0}.',
          plans
            .filter(p => count(p) > 0)
            .map(p => `${noteLabel(p.file)} ${count(p)}`)
            .join(', ')
        )}`
      : '';
  return [
    notRendered > 0
      ? plugin.t(
          '{0} table(s) were not exported: with no blank line above, the reading view shows them as text. Add a blank line above a table to export it.',
          String(notRendered)
        ) + where(p => p.notRendered)
      : '',
    hidden > 0
      ? plugin.t(
          '{0} table(s) were not exported: they are inside a comment, so the reading view does not show them at all.',
          String(hidden)
        ) + where(p => p.hidden)
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The opening line of the export notice. */
function exportedText(plugin: LabnotePlugin, written: number, total: number): string {
  const unchanged = total - written;
  return written === 0
    ? plugin.t('The CSV files are already up to date ({0}).', String(total))
    : unchanged > 0
      ? plugin.t('Exported {0} CSV file(s) ({1} unchanged file(s) left as they were).', String(written), String(unchanged))
      : plugin.t('Exported {0} CSV file(s).', String(written));
}

function renameText(plugin: LabnotePlugin, result: CsvWriteResult): string {
  const { renamed, notRenamed } = result;
  return [
    renamed.length > 0
      ? plugin.t(
          'Renamed {0} CSV file(s) so their numbers sort in table order: {1}. Update these paths in any analysis script.',
          String(renamed.length),
          renamed.length > 1 ? plugin.t('{0} (+{1} more)', renamed[0], String(renamed.length - 1)) : renamed[0]
        )
      : '',
    notRenamed > 0
      ? plugin.t('Could not rename {0} old CSV file(s); they keep their old names.', String(notRenamed))
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function exportTablesToCsv(plugin: LabnotePlugin, file: TFile): Promise<void> {
  const plan = await planNoteCsvExport(plugin, file);
  const skipped = skippedText(plugin, [plan]);
  if (plan.outputs.length === 0) {
    const cleanup = await offerStaleCsvCleanup(
      plugin,
      plan.dir,
      await staleCsvsOf(plugin, file, 0),
      await orphanCsvsIn(plugin, plan.dir)
    );
    new Notice([plugin.t('No tables found in this note.'), skipped, cleanup].filter(Boolean).join(' '));
    return;
  }
  if (!(await confirmOverwrites(plugin, [plan]))) {
    new Notice(plugin.t('No changes made.'));
    return;
  }
  const result = await writeNoteCsvExport(plugin, plan);
  const cleanup = await offerStaleCsvCleanup(
    plugin,
    plan.dir,
    await staleCsvsOf(plugin, file, plan.outputs.length),
    await orphanCsvsIn(plugin, plan.dir)
  );
  const paths = plan.outputs.map(o => o.path);
  new Notice(
    [
      exportedText(plugin, result.written, plan.outputs.length),
      renameText(plugin, result),
      savedIn(plugin, plan.dir, paths),
      skipped,
      excelHint(plugin, plan.outputs),
      excelPathHint(plugin, paths),
      cleanup,
      explorerHint(plugin),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * Export the tables of every note in an experiment folder (#347): the README
 * first, then the other notes by name — workflow notes and plain `.md` notes
 * alike, as exporting one of them does (#369). The overwrite and cleanup
 * prompts are asked once for all of them.
 */
export async function exportExperimentTablesToCsv(plugin: LabnotePlugin, dir: string): Promise<void> {
  const names = (await plugin.fs.list(dir)).filter(n => /\.md$/i.test(n));
  const ordered = [
    ...names.filter(n => n === 'README.labnote.md'),
    ...names.filter(n => n !== 'README.labnote.md').sort((a, b) => a.localeCompare(b)),
  ];
  const plans: NoteCsvPlan[] = [];
  for (const name of ordered) {
    const file = plugin.app.vault.getFileByPath(posix.join(dir, name));
    if (file instanceof TFile) plans.push(await planNoteCsvExport(plugin, file));
  }
  const skipped = skippedText(plugin, plans);
  const staleOf = async () =>
    (await Promise.all(plans.map(p => staleCsvsOf(plugin, p.file, p.outputs.length)))).flat();
  const cleanupAll = async () =>
    offerStaleCsvCleanup(plugin, dir, await staleOf(), await orphanCsvsIn(plugin, dir), 'many');
  const withTables = plans.filter(p => p.outputs.length > 0);
  if (withTables.length === 0) {
    const cleanup = await cleanupAll();
    new Notice(
      [plugin.t('No tables found in the notes of {0}.', posix.basename(dir)), skipped, cleanup].filter(Boolean).join(' ')
    );
    return;
  }
  if (!(await confirmOverwrites(plugin, withTables))) {
    new Notice(plugin.t('No changes made.'));
    return;
  }
  const result: CsvWriteResult = { written: 0, renamed: [], notRenamed: 0 };
  for (const plan of withTables) {
    const r = await writeNoteCsvExport(plugin, plan);
    result.written += r.written;
    result.renamed.push(...r.renamed);
    result.notRenamed += r.notRenamed;
  }
  const cleanup = await cleanupAll();
  const paths = withTables.flatMap(p => p.outputs.map(o => o.path));
  const perNote = withTables.map(p => `${noteLabel(p.file)} ${p.outputs.length}`);
  const withoutTables = plans.length - withTables.length;
  new Notice(
    [
      exportedText(plugin, result.written, paths.length),
      plugin.t('Tables per note: {0}.', listInline(plugin, perNote, 5)),
      withoutTables > 0 ? plugin.t('{0} note(s) without tables were skipped.', String(withoutTables)) : '',
      renameText(plugin, result),
      savedIn(plugin, dir, paths),
      skipped,
      excelHint(plugin, withTables.flatMap(p => p.outputs)),
      excelPathHint(plugin, paths),
      cleanup,
      explorerHint(plugin),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/** How Excel would change cells of `kind`, with the examples. */
function excelRiskText(plugin: LabnotePlugin, kind: ExcelRiskKind, examples: string): string {
  switch (kind) {
    case 'dateTime':
      return plugin.t('{0} become dates or times', examples);
    case 'negative':
      return plugin.t('{0} become negative numbers', examples);
    case 'precision':
      return plugin.t('{0} lose the digits past the 15th', examples);
    case 'leadingZero':
      return plugin.t('{0} lose their leading zeros', examples);
    case 'eNotation':
      return plugin.t('{0} become numbers in E notation (2E4 → 20000)', examples);
  }
}

/** CSVs the Excel warning names before counting the rest. */
const EXCEL_HINT_FILES = 5;

/**
 * How to open the CSV in Excel without it rewriting cells like `3-1`, `2:1`,
 * `007`, `(1)`, `2E4` or a 16-digit barcode (#256, #272, #343, #345, #346,
 * #376). Each CSV is named with the columns to set to Text, and each kind of
 * change with up to three examples and a count of the rest (#375). The file
 * keeps the text as typed; Excel is what changes it.
 */
function excelHint(plugin: LabnotePlugin, outputs: readonly CsvOutput[]): string {
  const parts = outputs
    .filter(o => o.risky.length > 0)
    .map(o => {
      const byKind = new Map<ExcelRiskKind, string[]>();
      for (const { text, kind } of o.risky) byKind.set(kind, [...(byKind.get(kind) ?? []), text]);
      const changes = [...byKind]
        .map(([kind, texts]) => excelRiskText(plugin, kind, listInline(plugin, texts, 3)))
        .join('; ');
      const columns = [...new Set(o.risky.flatMap(c => c.columns))]
        .sort((a, b) => a - b)
        .map(c => o.header[c]?.trim() || plugin.t('column {0}', String(c + 1)));
      return plugin.t('{0}, column(s) {1}: {2}', posix.basename(o.path), columns.join(', '), changes);
    });
  if (parts.length === 0) return '';
  const more = parts.length - EXCEL_HINT_FILES;
  const listed = parts.slice(0, EXCEL_HINT_FILES).join(' / ');
  return plugin.t(
    'Excel would change cells when it opens the CSV: {0}. Open the CSV with Data → From Text/CSV and set those columns to Text.',
    more > 0 ? `${listed} ${plugin.t('(+{0} more CSV file(s))', String(more))}` : listed
  );
}

/**
 * Excel does not open a file whose full path is past {@link EXCEL_PATH_MAX}
 * (#348). The CSVs are still written; the notice says which is too long.
 */
function excelPathHint(plugin: LabnotePlugin, paths: readonly string[]): string {
  const over = windowsPathsOver(plugin.app, paths, EXCEL_PATH_MAX);
  if (over.length === 0) return '';
  const name = posix.basename(over[0].path);
  return plugin.t(
    'Excel cannot open a file whose path is longer than {0} characters, and {1} is {2} characters long including the vault folder. Shorten the note name or move the vault to a shorter folder path.',
    String(EXCEL_PATH_MAX),
    over.length > 1 ? plugin.t('{0} (+{1} more)', name, String(over.length - 1)) : name,
    String(over[0].length)
  );
}

/** Where the CSVs are, so they can be found outside Obsidian (#140): the folder and the first few names. */
function savedIn(plugin: LabnotePlugin, dir: string, paths: readonly string[]): string {
  const names = listInline(plugin, paths.map(p => posix.basename(p)), 3);
  return plugin.t('Saved in {0}: {1}.', dir === '.' ? '/' : `${dir}/`, names);
}

/** The first `max` items joined by commas, and a count of the rest. */
function listInline(plugin: LabnotePlugin, items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? plugin.t('{0} (+{1} more)', shown, String(items.length - max)) : shown;
}

/**
 * Obsidian's file explorer hides CSVs unless "Show all file types" is on
 * (#140). `getConfig` is not in the public API; an unknown value gets the hint.
 */
function explorerHint(plugin: LabnotePlugin): string {
  const vault = plugin.app.vault as unknown as { getConfig?: (key: string) => unknown };
  if (vault.getConfig?.('showUnsupportedFiles') === true) return '';
  return plugin.t('The file explorer shows CSV files only when Settings → Files and links → Show all file types is on.');
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

/** Export the tables of the experiment the active note belongs to (#347, command palette). */
export async function exportActiveExperimentTablesToCsv(plugin: LabnotePlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  const dir = file ? getExperimentDir(file.path) : undefined;
  if (!dir) {
    new Notice(plugin.t('Open a note of an experiment first.'));
    return;
  }
  await exportExperimentTablesToCsv(plugin, dir);
}
