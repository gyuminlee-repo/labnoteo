/**
 * validate — deterministic server-side check for a research vault (Phase 3).
 *
 * Scans every `labnote/**\/README.labnote.md`, and for notes with
 * `experiment_type: labnote` verifies:
 *   - `status` is one of the controlled `EXPERIMENT_STATUSES` (required),
 *   - `id` values are unique across experiments (duplicate → error),
 *   - `@issue` markers in ANY `*.labnote.md` of the folder parse, and their IDs
 *     are unique within the experiment,
 *   - `labnote_id` values of the `*.labnote.md` notes are unique across the vault,
 * then re-runs the central large-file size guard.
 *
 * Lenient by design initially: only `status` is required; other fields are
 * recommended. Deterministic and AI-free. Exits non-zero with clear messages so
 * `validate.yml` gates a push. Reuses the SAME `@labnoteo/core` primitives the
 * plugin uses (no re-implementation → no drift) and the same large-file check.
 *
 * Zero runtime deps: node built-ins + inlined `@labnoteo/core`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isValidStatus, EXPERIMENT_STATUSES } from '@labnoteo/core/lib/experimentStatus';
import { parseFrontMatterYaml, parseIssueMarkers } from '@labnoteo/core';
import { unrecognizedDiscussValue } from '@labnoteo/core/lib/discussFlag';
import { findDuplicateNoteIds } from '@labnoteo/core/lib/noteId';
import { run as runLargeFileCheck } from './lib/largeFiles';
import { isVaultRoot, vaultRootFromScript } from './lib/vaultRoot';
import {
  findExperimentReadmes,
  README_NAME,
  readMarkerSources,
  readStringField,
  type MarkerSource,
} from './lib/experiments';

/** One parsed experiment handed to the pure validator. */
export interface ValidatedNote {
  /** Repo-relative POSIX path to the README. */
  path: string;
  frontMatter: Record<string, unknown>;
  /**
   * Every `*.labnote.md` in the experiment folder (README included), scanned
   * for `@issue` markers — the same scope `issue-sync` promotes from, so a
   * marker can never pass validation yet be ignored by the sync, or vice versa.
   */
  sources: MarkerSource[];
  /** Why the front matter could not be read, when it could not be. */
  parseError?: string;
}

/**
 * Pure validation of the experiment notes. Returns a list of human-readable
 * error strings (empty = valid). Kept side-effect free for unit testing.
 *
 * Rules (lenient phase): `status` required and must be a known value; `id`, when
 * present, must be unique across notes; `@issue` markers must be well formed
 * and their IDs unique within a note.
 *
 * Markers are checked strictly because the failure is otherwise silent — a
 * mistyped marker opens no issue and says nothing, so a discussion the
 * researcher believed they had raised is simply lost. Failing here costs a red
 * check (the pre-commit hook only guards file size, so the push still lands).
 */
export function validateExperiments(notes: ValidatedNote[]): string[] {
  const errors: string[] = [];
  const idOwners = new Map<string, string[]>();

  for (const note of notes) {
    // Check this BEFORE the `experiment_type` filter. A broken block parses as
    // "no fields", so the filter below used to drop the note from validation
    // entirely: an invalid `status` right next to a stray colon went green,
    // and the researcher got a passing check on a note nothing had inspected.
    // Markers still get checked — they live in the body, not the block.
    if (note.parseError) {
      errors.push(
        `${note.path}: front matter could not be parsed, so no field could be ` +
          `checked (${note.parseError}).`
      );
      errors.push(...validateMarkers(note));
      continue;
    }

    if (readStringField(note.frontMatter, 'experiment_type') !== 'labnote') continue;

    const status = readStringField(note.frontMatter, 'status');
    if (!status) {
      errors.push(`${note.path}: missing required \`status\` front-matter.`);
    } else if (!isValidStatus(status)) {
      errors.push(
        `${note.path}: invalid \`status: ${status}\` ` +
          `(allowed: ${EXPERIMENT_STATUSES.join(', ')}).`
      );
    }

    const id = readStringField(note.frontMatter, 'id');
    if (id) {
      const owners = idOwners.get(id) ?? [];
      owners.push(note.path);
      idOwners.set(id, owners);
    }

    errors.push(...validateMarkers(note));
  }

  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      errors.push(`Duplicate \`id: ${id}\` used by: ${owners.join(', ')}.`);
    }
  }

  // A copied note keeps the original's ID, and scans of either would land in one of them.
  const noteIds = notes.flatMap(n => n.sources.flatMap(s => (s.noteId ? [{ path: s.path, id: s.noteId }] : [])));
  for (const [id, owners] of findDuplicateNoteIds(noteIds)) {
    errors.push(
      `Duplicate \`labnote_id: ${id}\` used by: ${owners.join(', ')}. ` +
        'Delete the `labnote_id` line of the copy and run "Assign note ID" in Obsidian to give it its own.'
    );
  }

  return errors;
}

/**
 * Warnings that do not fail the check: a `discuss` value that reads as neither
 * on nor off (#208), which opens no issue although the researcher may think
 * the experiment is flagged.
 */
export function validationWarnings(notes: ValidatedNote[]): string[] {
  const warnings: string[] = [];
  for (const note of notes) {
    if (note.parseError || readStringField(note.frontMatter, 'experiment_type') !== 'labnote') continue;
    const discuss = unrecognizedDiscussValue(note.frontMatter);
    if (discuss !== undefined) {
      warnings.push(
        `${note.path}: \`discuss: ${discuss}\` is not read as a discussion flag, so no issue is opened ` +
          '(use `true`, `yes` or `예` to flag, or remove the line).'
      );
    }
  }
  return warnings;
}

/**
 * Errors for one experiment's `@issue` markers: malformed ones, and IDs reused
 * within the experiment (which would collapse two discussions into one issue).
 *
 * Uniqueness is checked across the whole folder, not per file, because the
 * issue identifier is `<experiment>/<marker ID>` — two files in one experiment
 * sharing an ID would silently target the same issue.
 *
 * Line numbers are translated to FILE lines so the message points where the
 * editor does.
 */
function validateMarkers(note: ValidatedNote): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const source of note.sources) {
    const { markers, malformed } = parseIssueMarkers(source.body);

    for (const bad of malformed) {
      const detail = bad.reason === 'missing-id' ? 'missing marker ID' : 'missing topic sentence';
      errors.push(
        `${source.path}:${bad.line + source.bodyLineOffset}: malformed \`@issue\` marker ` +
          `(${detail}). Expected \`@issue;<ID>;<topic>\` — use the ` +
          `"Insert issue marker" command so the ID is generated for you. Got: ${bad.text}`
      );
    }

    for (const marker of markers) {
      const where = `${source.path}:${marker.line + source.bodyLineOffset}`;
      const first = seen.get(marker.id);
      if (first !== undefined) {
        errors.push(`${where}: duplicate marker ID \`${marker.id}\` (already used at ${first}).`);
      } else {
        seen.set(marker.id, where);
      }
    }
  }

  return errors;
}

/** Load and parse every experiment README under `labnote/`. */
function loadNotes(): ValidatedNote[] {
  return findExperimentReadmes().map(path => {
    let frontMatter: Record<string, unknown> = {};
    let parseError: string | undefined;
    try {
      const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      ({ frontMatter, parseError } = parseFrontMatterYaml(raw));
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    const dir = path.slice(0, -(README_NAME.length + 1));
    return { path, frontMatter, sources: readMarkerSources(dir), parseError };
  });
}

/**
 * Run all checks. Returns the process exit code (0 = ok, 1 = failures).
 *
 * `--notes-only` skips the large-file re-check. The pre-commit hook needs that:
 * it has already checked the staged files, whereas the re-check here scans the
 * whole vault, so without the flag every commit would re-report files that were
 * committed long ago.
 */
export function run(argv: string[] = process.argv.slice(2)): number {
  const notesOnly = argv.includes('--notes-only');
  const notes = loadNotes();
  const errors = validateExperiments(notes);

  for (const warning of validationWarnings(notes)) {
    console.warn(`⚠ ${warning}`);
  }
  for (const err of errors) {
    console.error(`❌ ${err}`);
  }

  // Central re-run of the large-file guard (same module the hook uses).
  const largeFileCode = notesOnly ? 0 : runLargeFileCheck([]);

  if (errors.length === 0 && largeFileCode === 0) {
    // Zero notes is not a pass: nothing was checked (#129). It stays exit 0 so
    // a vault without experiments yet does not fail a manual run.
    if (notes.length === 0) {
      console.log('⚠ validate: 검증할 실험 노트가 없습니다(labnote/**/README.labnote.md 0개).');
    } else {
      console.log(`✅ validate: ${notes.length}개 노트 검증 통과.`);
    }
    return 0;
  }
  if (errors.length > 0) {
    console.error(`\n${errors.length}개 검증 오류가 있습니다. 위 메시지를 확인하세요.`);
  }
  return errors.length > 0 || largeFileCode !== 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Here, not in `run()`: the checks read vault-relative paths, and the tests
  // call `run()` from this repo's root, which is no vault.
  const root = vaultRootFromScript(fileURLToPath(import.meta.url));
  if (root) process.chdir(root);
  if (!isVaultRoot(process.cwd())) {
    console.error(
      `❌ validate: 보관함 루트를 찾지 못했습니다(${process.cwd()}에 .labnoteo/ 없음). 보관함 루트에서 실행하세요.`
    );
    process.exit(2);
  }
  process.exit(run());
}
