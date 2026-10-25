/**
 * `@issue` marker IDs of each experiment, by note, for spotting a marker that
 * was copied with its ID (#119). `issue-sync` keys an issue by experiment and
 * marker ID, so a pasted marker silently joins the original's issue; only
 * `validate` used to say so, and only after a push.
 *
 * The scope is `validate`'s: the `*.labnote.md` notes directly in the
 * experiment folder, read without their front matter and fenced code.
 */
import { parseFrontMatterYaml, parseIssueMarkers, type LabnoteFs } from '@labnoteo/core';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import * as posix from '@labnoteo/core/posix';

const LABNOTE_SUFFIX = '.labnote.md';

/** Marker IDs in a note, as `validate` reads it. */
export function noteMarkerIds(md: string): string[] {
  const { body } = parseFrontMatterYaml(md.replace(/\r\n/g, '\n'));
  return parseIssueMarkers(body).markers.map(m => m.id);
}

/** Where an `@issue` marker is: its note, 1-based line in the file, and topic. */
export interface MarkerSpot {
  path: string;
  line: number;
  title: string;
}

/** The markers of `md` as `validate` reads them, by line of the whole file. */
export function noteMarkerSpots(path: string, md: string): MarkerSpot[] {
  const text = md.replace(/\r\n/g, '\n');
  const { body } = parseFrontMatterYaml(text);
  const skipped = text.slice(0, text.length - body.length).split('\n').length - 1;
  return parseIssueMarkers(body).markers.map(m => ({ path, line: m.line + skipped, title: m.title }));
}

/**
 * The markers of the notes directly in experiment `dir`, the ones the workflow
 * view counts (#379, #380), in file name order.
 */
export async function experimentMarkerSpots(fs: LabnoteFs, dir: string): Promise<MarkerSpot[]> {
  const spots: MarkerSpot[] = [];
  for (const name of [...(await fs.list(dir))].sort()) {
    if (!name.toLowerCase().endsWith(LABNOTE_SUFFIX)) continue;
    const path = posix.join(dir, name);
    try {
      spots.push(...noteMarkerSpots(path, await fs.read(path)));
    } catch {
      // a folder named like a note, or a file gone mid-scan
    }
  }
  return spots;
}

/** `001_WB090_x.labnote.md:48, …` for a message, naming at most `max` spots. */
export function formatMarkerSpots(spots: readonly MarkerSpot[], t: (key: string, ...args: string[]) => string, max = 3): string {
  const named = spots
    .slice(0, max)
    .map(s => `${posix.basename(s.path)}:${s.line}`)
    .join(', ');
  return spots.length > max ? t('{0} (+{1} more)', named, String(spots.length - max)) : named;
}

/** The experiment whose markers `path` shares IDs with, or undefined. */
export function markerExperimentDir(path: string | undefined): string | undefined {
  if (!path?.endsWith(LABNOTE_SUFFIX)) return undefined;
  const dir = getExperimentDir(path);
  return dir && posix.dirname(path) === dir ? dir : undefined;
}

/** A marker ID used more than once; `owner` is the other note, undefined when this note repeats it. */
export interface DuplicateMarker {
  id: string;
  owner: string | undefined;
}

/** The other notes' marker IDs as seen from one note. */
export interface OtherMarkerIds {
  /** Marker ID → name of a note that uses it. */
  ids: ReadonlyMap<string, string>;
  /** Changes whenever `ids` may have. */
  version: number;
}

export class IssueMarkerIndex {
  private readonly dirs = new Map<string, Map<string, string[]>>();
  private readonly loading = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly othersCache = new Map<string, OtherMarkerIds>();

  /** `onChange` runs after an experiment is read or one of its notes changes. */
  constructor(
    private readonly fs: LabnoteFs,
    private readonly onChange: () => void
  ) {}

  /**
   * The marker IDs of the other notes of `path`'s experiment. Called on every
   * editor update, so it only looks things up: the first call for an
   * experiment starts reading it and answers undefined until that is done.
   */
  othersFor(path: string | undefined): OtherMarkerIds | undefined {
    const dir = markerExperimentDir(path);
    if (!dir || !path) return undefined;
    const files = this.dirs.get(dir);
    if (!files) {
      void this.load(dir);
      return undefined;
    }
    const version = this.versions.get(dir) ?? 0;
    const cached = this.othersCache.get(path);
    if (cached?.version === version) return cached;
    const ids = new Map<string, string>();
    for (const [file, list] of files) {
      if (file === path) continue;
      for (const id of list) if (!ids.has(id)) ids.set(id, posix.basename(file));
    }
    const entry = { ids, version };
    this.othersCache.set(path, entry);
    return entry;
  }

  /** Whether `path`'s experiment has been read, so changes to it are tracked. */
  tracks(path: string): boolean {
    const dir = markerExperimentDir(path);
    return dir !== undefined && this.dirs.has(dir);
  }

  /**
   * Record `path`'s current text. Returns the marker IDs of `path` that became
   * duplicates with this change, so each is reported once.
   */
  update(path: string, content: string): DuplicateMarker[] {
    const dir = markerExperimentDir(path);
    const files = dir ? this.dirs.get(dir) : undefined;
    if (!dir || !files) return [];
    const before = new Set(this.duplicatesOf(path, files).map(d => d.id));
    const ids = noteMarkerIds(content);
    const old = files.get(path);
    if (old && old.length === ids.length && old.every((id, i) => id === ids[i])) return [];
    files.set(path, ids);
    this.bump(dir);
    return this.duplicatesOf(path, files).filter(d => !before.has(d.id));
  }

  /** Forget a deleted or renamed-away note. */
  remove(path: string): void {
    const dir = markerExperimentDir(path);
    const files = dir ? this.dirs.get(dir) : undefined;
    this.othersCache.delete(path);
    if (!dir || !files?.delete(path)) return;
    this.bump(dir);
  }

  private duplicatesOf(path: string, files: Map<string, string[]>): DuplicateMarker[] {
    const own = files.get(path) ?? [];
    const out: DuplicateMarker[] = [];
    const seen = new Set<string>();
    for (const id of own) {
      if (seen.has(id)) continue;
      seen.add(id);
      let owner: string | undefined;
      for (const [file, list] of files) {
        if (file !== path && list.includes(id)) {
          owner = posix.basename(file);
          break;
        }
      }
      if (owner !== undefined || own.indexOf(id) !== own.lastIndexOf(id)) out.push({ id, owner });
    }
    return out;
  }

  private async load(dir: string): Promise<void> {
    if (this.loading.has(dir)) return;
    this.loading.add(dir);
    try {
      const files = new Map<string, string[]>();
      for (const name of await this.fs.list(dir)) {
        if (!name.endsWith(LABNOTE_SUFFIX)) continue;
        const path = posix.join(dir, name);
        try {
          files.set(path, noteMarkerIds(await this.fs.read(path)));
        } catch {
          // a folder named like a note, or a file gone mid-scan
        }
      }
      this.dirs.set(dir, files);
      this.bump(dir);
    } catch (err) {
      console.error('[labnoteo] reading issue markers failed:', err);
      // Not retried on every keystroke; the notes' own changes still arrive.
      this.dirs.set(dir, new Map());
    } finally {
      this.loading.delete(dir);
    }
  }

  private bump(dir: string): void {
    this.versions.set(dir, (this.versions.get(dir) ?? 0) + 1);
    this.onChange();
  }
}
