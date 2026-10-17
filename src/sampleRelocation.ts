/**
 * Bring Local samples along when notes move to another experiment (#97).
 *
 * A note reads Local samples from its own experiment's `resources/labsamples`,
 * so after a move the samples it used stay in the old experiment and its
 * references stop resolving. Two entry points share the planning here: the
 * rename listener in main.ts (right after a move) and "Sync workflow checklist
 * with folder" (for moves made earlier or declined at the time).
 */
import type { App } from 'obsidian';
import type { LabnoteHost } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import {
  deleteSampleRecord,
  extractSampleInfoFromText,
  loadSamplesByType,
  planLocalSampleAdoption,
  putSampleRecord,
  removeSampleSource,
  sampleReferenceKey,
  sampleTypesInText,
  type SampleAdoption,
  type SampleDatabase,
} from '@labnoteo/core/lib/sampleStorage';
import { notesInSampleScope } from './sampleActions';

export interface SampleRelocationDeps {
  app: App;
  host: LabnoteHost;
  globalSampleFolder: string;
  customTypes: string[];
  /** Refresh the sample view and autocomplete after a write. */
  onSamplesChanged: () => void;
}

/** A note now in the target experiment, with the name it had before. */
export interface RelocatedNote {
  path: string;
  oldName: string;
}

/** One planned sample, merged across every note that uses it. */
interface PlannedAdoption extends SampleAdoption {
  fromDir: string;
  /** Old file names to drop from the old record's `sources` on a copy. */
  oldNames: string[];
  /** The old record's `sources`, before the plan rewrote them. */
  oldSources: string[];
}

const labsamplesOf = (experimentDir: string): string =>
  posix.join(experimentDir, 'resources', 'labsamples');

/** Load the given `{Type}.json` registries of one folder. */
async function loadDatabase(
  host: LabnoteHost,
  folder: string,
  types: readonly string[]
): Promise<SampleDatabase> {
  const db: SampleDatabase = {};
  if (!folder) return db;
  for (const type of types) db[type] = await loadSamplesByType(host.fs, folder, type);
  return db;
}

/** A note's saved text. */
async function readNote(app: App, path: string): Promise<string | undefined> {
  const file = app.vault.getFileByPath(path);
  return file ? app.vault.cachedRead(file) : undefined;
}

/** Plan what `notes` (now in `toDir`) need from `fromDir`'s Local registry. */
async function planFrom(
  deps: SampleRelocationDeps,
  fromDir: string,
  toDir: string,
  notes: readonly RelocatedNote[]
): Promise<PlannedAdoption[]> {
  const { app, host, customTypes } = deps;
  const texts: Array<{ note: RelocatedNote; text: string }> = [];
  for (const note of notes) {
    const text = await readNote(app, note.path);
    if (text !== undefined) texts.push({ note, text });
  }
  const types = [...new Set(texts.flatMap(t => sampleTypesInText(t.text, customTypes)))];
  if (types.length === 0) return [];

  const fromFolder = labsamplesOf(fromDir);
  const from = await loadDatabase(host, fromFolder, types);
  if (Object.values(from).every(records => Object.keys(records).length === 0)) return [];
  const to = await loadDatabase(host, labsamplesOf(toDir), types);
  const global = await loadDatabase(host, deps.globalSampleFolder, types);

  const planNote = (text: string, newName: string, usedElsewhere: ReadonlySet<string>) =>
    planLocalSampleAdoption({ noteText: text, newName, from, to, global, usedElsewhere, additionalTypes: customTypes });

  // Scanning the old experiment's notes is the costly part; skip it when no
  // note has anything to bring.
  if (texts.every(({ note, text }) => planNote(text, posix.basename(note.path), new Set()).length === 0)) {
    return [];
  }
  const usedElsewhere = new Set<string>();
  for (const doc of await notesInSampleScope(app, fromFolder)) {
    for (const s of extractSampleInfoFromText(doc.text, customTypes)) {
      usedElsewhere.add(sampleReferenceKey(s.type, s.id));
    }
  }

  const merged = new Map<string, PlannedAdoption>();
  for (const { note, text } of texts) {
    const planned = planNote(text, posix.basename(note.path), usedElsewhere);
    for (const a of planned) {
      const key = sampleReferenceKey(a.type, a.id);
      const prev = merged.get(key);
      if (prev) {
        prev.record.sources = [...new Set([...prev.record.sources, ...a.record.sources])];
        if (!prev.oldNames.includes(note.oldName)) prev.oldNames.push(note.oldName);
      } else {
        merged.set(key, {
          ...a,
          fromDir,
          oldNames: [note.oldName],
          oldSources: from[a.type]?.[a.id]?.sources ?? [],
        });
      }
    }
  }
  return [...merged.values()];
}

function describe(host: LabnoteHost, a: PlannedAdoption): string {
  const label = a.record.alias ? `${a.id} (${a.record.alias})` : a.id;
  const from = posix.basename(a.fromDir);
  return `- ${label}: ${
    a.action === 'copy'
      ? host.t('copy from {0} (still used there)', from)
      : host.t('move from {0}', from)
  }`;
}

async function apply(deps: SampleRelocationDeps, toDir: string, plan: readonly PlannedAdoption[]): Promise<number> {
  const { host } = deps;
  const toFolder = labsamplesOf(toDir);
  for (const a of plan) {
    await putSampleRecord(host.fs, toFolder, a.type, a.id, a.record);
    const fromFolder = labsamplesOf(a.fromDir);
    if (a.action === 'move') {
      await deleteSampleRecord(host.fs, fromFolder, a.type, a.id);
    } else {
      for (const name of a.oldNames) await removeSampleSource(host.fs, fromFolder, a.type, a.id, name);
    }
  }
  if (plan.length > 0) deps.onSamplesChanged();
  return plan.length;
}

/** Ask, then re-plan from disk (it may have changed while asking) and apply. */
async function confirmAndApply(
  deps: SampleRelocationDeps,
  toDir: string,
  plan: readonly PlannedAdoption[],
  replan: () => Promise<PlannedAdoption[]>
): Promise<number | undefined> {
  const { host } = deps;
  const ok = await host.confirm(
    `${host.t(
      "Notes in {0} use {1} local sample(s) that are still in another experiment's registry, so the notes cannot find them. Bring them into {0}?",
      posix.basename(toDir),
      String(plan.length)
    )}\n\n${plan.map(a => describe(host, a)).join('\n')}`,
    { confirmLabel: host.t('Bring samples') }
  );
  if (!ok) return undefined;
  const wanted = new Set(plan.map(a => `${a.fromDir}\u0000${sampleReferenceKey(a.type, a.id)}`));
  const fresh = (await replan()).filter(a =>
    wanted.has(`${a.fromDir}\u0000${sampleReferenceKey(a.type, a.id)}`)
  );
  return apply(deps, toDir, fresh);
}

/**
 * After notes moved from `fromDir` into `toDir`, offer to bring the Local
 * samples they use. With `ask` false (a prompt cannot be shown now) only say
 * how to bring them later. Returns how many were brought in.
 */
export async function offerSamplesAfterMove(
  deps: SampleRelocationDeps,
  fromDir: string,
  toDir: string,
  notes: readonly RelocatedNote[],
  ask = true
): Promise<number> {
  const { host } = deps;
  const replan = () => planFrom(deps, fromDir, toDir, notes);
  const plan = await replan();
  if (plan.length === 0) return 0;
  const brought = ask ? await confirmAndApply(deps, toDir, plan, replan) : undefined;
  if (brought === undefined) {
    notifyLeftBehind(host, fromDir, toDir);
    return 0;
  }
  host.notify(
    'info',
    host.t('Brought {0} local sample(s) into {1}.', String(brought), posix.basename(toDir))
  );
  return brought;
}

/** The samples stayed behind; say how to bring them later. */
function notifyLeftBehind(host: LabnoteHost, fromDir: string, toDir: string): void {
  host.notify(
    'info',
    host.t(
      'The local samples stay in {0}. To bring them later, run "{1}" from a note in {2}.',
      posix.basename(fromDir),
      host.t('Sync workflow checklist with folder'),
      posix.basename(toDir)
    )
  );
}

/**
 * For "Sync workflow checklist with folder": find the Local samples the notes
 * in `toDir` use but that only another experiment registers, and offer to bring
 * them in. A sample found in more than one other experiment is reported, not
 * guessed, unless exactly one of them lists the note in its `sources`. Returns
 * how many were brought in.
 */
export async function offerSamplesLeftBehind(
  deps: SampleRelocationDeps,
  toDir: string,
  names: readonly string[]
): Promise<number> {
  const { app, host } = deps;
  const notes = names.map(name => ({ path: posix.join(toDir, name), oldName: name }));
  const root = posix.dirname(toDir);
  const rootFolder = app.vault.getFolderByPath(root);
  if (!rootFolder || notes.length === 0) return 0;
  const others = rootFolder.children
    .map(child => child.path)
    .filter(p => p !== toDir && /^\d{3}_/.test(posix.basename(p)) && app.vault.getFolderByPath(p));

  const replan = async (): Promise<PlannedAdoption[]> => {
    const candidates = new Map<string, PlannedAdoption[]>();
    for (const dir of others) {
      for (const a of await planFrom(deps, dir, toDir, notes)) {
        const key = sampleReferenceKey(a.type, a.id);
        candidates.set(key, [...(candidates.get(key) ?? []), a]);
      }
    }
    const chosen: PlannedAdoption[] = [];
    ambiguous = [];
    for (const list of candidates.values()) {
      const listed = list.filter(a => a.oldNames.some(name => a.oldSources.includes(name)));
      if (list.length === 1) chosen.push(list[0]);
      else if (listed.length === 1) chosen.push(listed[0]);
      else ambiguous.push(list);
    }
    return chosen;
  };
  let ambiguous: PlannedAdoption[][] = [];

  const plan = await replan();
  if (ambiguous.length > 0) {
    host.notify(
      'warn',
      host.t(
        'These samples are registered in more than one other experiment, so they were not brought in: {0}',
        ambiguous
          .map(list => `${list[0].id} (${list.map(a => posix.basename(a.fromDir)).join(', ')})`)
          .join('; ')
      )
    );
  }
  if (plan.length === 0) return 0;
  return (await confirmAndApply(deps, toDir, plan, replan)) ?? 0;
}
