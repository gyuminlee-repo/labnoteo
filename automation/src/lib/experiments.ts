/**
 * Deterministic experiment-context gathering shared by the vault automation
 * scripts (issue-sync, issue-gate, wiki-propose).
 *
 * Everything here is deterministic — no AI. The identifier, title and Objective
 * are derived by pure rules from the note itself so the automation never invents
 * content. The heavy lifting (front-matter parse, path scoping) is delegated to
 * `@labnoteo/core`, so these scripts stay in lock-step with the plugin runtime
 * (the no-drift guarantee — do NOT re-implement those primitives here).
 *
 * Zero runtime deps: only node built-ins + the inlined `@labnoteo/core`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { findEnclosingHeading, parseFrontMatterYaml, type IssueMarker } from '@labnoteo/core';

/** File name of the single-source-of-truth note inside each experiment folder. */
export const README_NAME = 'README.labnote.md';

/** Suffix shared by the README and every workflow note in an experiment. */
export const LABNOTE_SUFFIX = '.labnote.md';

/** Heading of the Objective section extracted deterministically for issues. */
export const OBJECTIVE_HEADING = '🎯 Experiment Objective';

/**
 * Default placeholder body seeded by `generateReadmeContent`. When the Objective
 * section still holds this, there is no real objective yet, so it is omitted.
 */
export const OBJECTIVE_PLACEHOLDER =
  'Briefly describe the main objective and hypothesis of this experiment.';

/** A parsed experiment note (README front-matter + body + location). */
export interface ExperimentNote {
  /** `labnote/###_Name` folder (POSIX) that owns the note. */
  dir: string;
  /** Folder base name, e.g. `001_PCR_Optimization`. */
  folderName: string;
  /** Parsed README front-matter. */
  frontMatter: Record<string, unknown>;
  /** README body (front-matter stripped). */
  body: string;
}

/**
 * One note file scanned for `@issue` markers.
 *
 * Markers are NOT a README-only affair: the run itself is written in the
 * workflow notes, so that is where a question about it is raised. Every
 * `*.labnote.md` in the folder is therefore a marker source, and each carries
 * its own path and offset because the issue must link to the line the
 * researcher actually wrote on.
 */
export interface MarkerSource {
  /** Repo-relative POSIX path of the file holding the markers. */
  path: string;
  /** Body (front-matter stripped). */
  body: string;
  /**
   * Lines dropped ahead of `body` (front matter + blank lines). Added to a
   * body-relative line number it yields the line in the FILE, which is what a
   * GitHub permalink needs.
   */
  bodyLineOffset: number;
  /** The file's `labnote_id`, when it has a valid one. */
  noteId?: string;
}

/** Read a front-matter string field, trimmed; undefined when absent/blank. */
export function readStringField(
  frontMatter: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = frontMatter[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Base name of an experiment folder path (`labnote/001_Foo` → `001_Foo`).
 * Pure string logic; tolerant of a trailing slash.
 */
export function experimentFolderName(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? dir;
}

/**
 * The automation identifier for an experiment: the front-matter `id` when set
 * (e.g. `EXP-001`), otherwise the folder name `###_Name`. This is the stable
 * link key between a note, its Issue and the Wiki — NOT the Issue number.
 */
export function deriveIdentifier(
  frontMatter: Record<string, unknown>,
  folderName: string
): string {
  return readStringField(frontMatter, 'id') ?? folderName;
}

/**
 * Issue title `[identifier] <note title>`. Falls back to the identifier as the
 * title text when the note has no `title` front-matter.
 */
export function deriveIssueTitle(
  identifier: string,
  frontMatter: Record<string, unknown>
): string {
  const title = readStringField(frontMatter, 'title') ?? identifier;
  return `[${identifier}] ${title}`;
}

/**
 * Body of the first Markdown section whose heading text equals `heading`
 * (matched at any `#`..`######` level), trimmed. Returns undefined when the
 * heading is absent. Pure; mirrors the boundary rule of core `replaceSectionBody`
 * (section runs until the next heading of the same or higher level). Blockquote
 * markers (`>`) are stripped so a placeholder/objective reads as plain prose.
 */
export function getSectionBody(md: string, heading: string): string | undefined {
  const lines = md.split(/\r?\n/);
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return undefined;

  const boundary = new RegExp(`^#{1,${level}}\\s`);
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (boundary.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start, end)
    .map(line => line.replace(/^\s*>\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return body;
}

/**
 * Deterministically extract the experiment Objective from the README body.
 * Returns undefined when the section is missing, empty, or still the seeded
 * placeholder (so issues omit a meaningless objective). NEVER uses AI.
 */
export function extractObjective(body: string): string | undefined {
  const section = getSectionBody(body, OBJECTIVE_HEADING);
  if (!section) return undefined;
  const normalized = section.replace(/\s+/g, ' ').trim();
  if (normalized === '' || normalized === OBJECTIVE_PLACEHOLDER) return undefined;
  return section;
}

/**
 * Group a list of changed files into the unique set of `labnote/###_Name`
 * experiment folders they belong to (via core `getExperimentDir`). Files outside
 * any experiment (or non-`###_` folders) are ignored. Order is deterministic
 * (sorted) so downstream output is stable.
 */
export function groupChangedExperiments(changedFiles: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of changedFiles) {
    const dir = getExperimentDir(file);
    if (dir) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Directories never worth descending into when walking a vault. */
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Every `README.labnote.md` under `root`, at any depth, sorted.
 *
 * Deliberately NOT filtered to `###_` folders: `validate` must report problems
 * in a misnamed folder rather than silently skip it. Callers that act on
 * experiments (issue-sync) narrow the result with `getExperimentDir`, which is
 * the stricter rule the push-diff path already uses.
 *
 * Returns an empty list when `root` is absent, so a vault without notes is not
 * an error.
 */
export function findExperimentReadmes(root = 'labnote'): string[] {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name === README_NAME) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Every experiment folder in the vault, by the same rule the push-diff path
 * uses (`getExperimentDir`). Backing a `--all` backfill with this keeps manual
 * runs from reaching folders a normal push could never promote.
 */
export function findAllExperimentDirs(root = 'labnote'): string[] {
  const dirs = new Set<string>();
  for (const readme of findExperimentReadmes(root)) {
    const dir = getExperimentDir(readme);
    if (dir) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** A deterministic issue payload derived from an experiment note. */
export interface ExperimentIssue {
  identifier: string;
  title: string;
  body: string;
  labels: string[];
}

/**
 * Build the deterministic Issue payload for an experiment (shared by the 4a
 * deterministic path and the 4b AI-gated path so both create identical issues).
 *
 * Body = note link + deterministically extracted Objective (omitted when it is
 * the placeholder) + status + an empty Discussion prompt. NEVER a full copy of
 * the note. Labels = `experiment` plus `status:<status>` when a status is set.
 */
export function buildExperimentIssue(note: ExperimentNote): ExperimentIssue {
  const identifier = deriveIdentifier(note.frontMatter, note.folderName);
  const title = deriveIssueTitle(identifier, note.frontMatter);
  const status = readStringField(note.frontMatter, 'status');
  const objective = extractObjective(note.body);

  const labels = ['experiment'];
  if (status) labels.push(`status:${status}`);

  const lines: string[] = [
    `**Experiment:** \`${identifier}\``,
    `**Note:** \`${note.dir}/${README_NAME}\``,
    `**Status:** ${status ?? '(unset)'}`,
    '',
    '## 🎯 Objective',
    objective ?? '_No objective recorded in the note yet._',
    '',
    '## 💬 Discussion',
    '_Use this issue to discuss this experiment. The linked note remains the source of truth._',
  ];

  return { identifier, title, body: lines.join('\n'), labels };
}

/**
 * Build the Issue payload for one `@issue` marker.
 *
 * The identifier is namespaced under the experiment (`EXP-001/ISS-mkd8x3k`) so
 * a note can carry several independent discussions. It cannot be confused with
 * the experiment's own `[EXP-001]` token: the `/` breaks the closing bracket,
 * so neither title contains the other's token.
 *
 * The body is context, never a copy of the note: the topic sentence, the
 * section the marker sits in, and a permalink to that exact line at `sha` —
 * which is the whole point of a point-level marker. `sha` is the pushed commit
 * (`GITHUB_SHA`); without it the permalink is omitted rather than guessed.
 */
export function buildDiscussionIssue(
  note: ExperimentNote,
  source: MarkerSource,
  marker: IssueMarker,
  repo: string,
  sha?: string
): ExperimentIssue {
  const experimentId = deriveIdentifier(note.frontMatter, note.folderName);
  const identifier = `${experimentId}/${marker.id}`;
  const status = readStringField(note.frontMatter, 'status');
  const notePath = source.path;
  const fileLine = marker.line + source.bodyLineOffset;
  const section = findEnclosingHeading(source.body, marker.line);

  const labels = ['experiment', 'discussion'];
  if (status) labels.push(`status:${status}`);

  const lines: string[] = [
    `**Experiment:** \`${experimentId}\``,
    `**Note:** \`${notePath}\`${section ? ` → ${section}` : ''}`,
    `**Marker:** \`${marker.id}\``,
  ];
  if (sha) {
    lines.push(`**Line:** ${apiHtmlUrl(repo, sha, notePath, fileLine)}`);
  }
  lines.push(
    '',
    '## 💬 Discussion',
    marker.title,
    '',
    '_Raised from a marker in the note. The note remains the source of truth; ' +
      'removing the marker does not close this issue._'
  );

  return { identifier, title: `[${identifier}] ${marker.title}`, body: lines.join('\n'), labels };
}

/** Permalink to one line of a file at a commit. */
function apiHtmlUrl(repo: string, sha: string, path: string, line: number): string {
  const base = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/+$/, '');
  return `${base}/${repo}/blob/${sha}/${path}#L${line}`;
}

/**
 * Read and parse an experiment's README. Returns undefined when the README is
 * missing or is not an `experiment_type: labnote` note (so non-experiments and
 * partial folders are skipped). Uses node fs; the pure parsing is delegated to
 * core `parseFrontMatterYaml`.
 */
export function readExperimentNote(dir: string): ExperimentNote | undefined {
  const readmePath = `${dir}/${README_NAME}`;
  if (!existsSync(readmePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
  const { frontMatter, body } = parseFrontMatterYaml(raw);
  if (readStringField(frontMatter, 'experiment_type') !== 'labnote') return undefined;
  return { dir, folderName: experimentFolderName(dir), frontMatter, body };
}

/**
 * Every `*.labnote.md` in an experiment folder, README first and the workflow
 * notes after it in name order (so output and issue creation are stable).
 *
 * The whole folder is read, not just the files this push changed: a marker
 * written before the automation could act on it would otherwise stay invisible
 * until the researcher happened to edit that note again. Re-reading is safe
 * because `ensureIssue` is idempotent.
 *
 * Unreadable files are skipped rather than guessed at — `validate` reports them.
 */
export function readMarkerSources(dir: string): MarkerSource[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(LABNOTE_SUFFIX))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
  names.sort((a, b) => (a === README_NAME ? -1 : b === README_NAME ? 1 : 0));

  const sources: MarkerSource[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    try {
      const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      const { body } = parseFrontMatterYaml(raw);
      // `body` is a suffix of `raw`, so the line delta is exactly what was dropped.
      sources.push({
        path,
        body,
        bodyLineOffset: raw.split('\n').length - body.split('\n').length,
        noteId: readNoteId(raw),
      });
    } catch {
      continue;
    }
  }
  return sources;
}
