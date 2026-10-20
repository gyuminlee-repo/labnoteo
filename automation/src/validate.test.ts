// Globals convention (no `import ... from 'vitest'`) — matches the core tests.
//
// Pins the pure, deterministic validation rules (Phase 3): `status` required and
// controlled, `id` unique, non-labnote notes ignored.
const largeFileCheck = vi.hoisted(() => vi.fn(() => 0));
vi.mock('./lib/largeFiles', () => ({ run: largeFileCheck }));

import { run, validateExperiments, validationWarnings, type ValidatedNote } from './validate';

const note = (
  path: string,
  fm: Record<string, unknown>,
  body = '',
  bodyLineOffset = 0
): ValidatedNote => ({
  path,
  frontMatter: { experiment_type: 'labnote', ...fm },
  sources: [{ path, body, bodyLineOffset }],
});

describe('validateExperiments', () => {
  it('accepts a note with a valid status', () => {
    expect(validateExperiments([note('a', { status: 'in-progress' })])).toEqual([]);
  });

  it('flags a missing status', () => {
    const errors = validateExperiments([note('labnote/001_A/README.labnote.md', {})]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing required `status`');
  });

  it('flags an invalid status value', () => {
    const errors = validateExperiments([note('a', { status: 'done' })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid `status: done`');
  });

  // A broken front-matter block parses as "no fields", so it used to slip
  // through the `experiment_type: labnote` filter and leave the note
  // uninspected — the check went green on a note nothing had validated.
  describe('unparseable front matter', () => {
    const broken = (path: string, body = ''): ValidatedNote => ({
      path,
      frontMatter: {},
      sources: [{ path, body, bodyLineOffset: 0 }],
      parseError: 'bad indentation of a mapping entry',
    });

    it('reports the note instead of silently skipping it', () => {
      const errors = validateExperiments([broken('labnote/001_A/README.labnote.md')]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('front matter could not be parsed');
      expect(errors[0]).toContain('labnote/001_A/README.labnote.md');
      expect(errors[0]).toContain('bad indentation of a mapping entry');
    });

    it('does not also report a missing status, which would be misleading', () => {
      // The status may well be there; it just could not be read.
      const errors = validateExperiments([broken('a')]);
      expect(errors.some(e => e.includes('missing required `status`'))).toBe(false);
    });

    it('still validates markers, which live in the body not the block', () => {
      const errors = validateExperiments([broken('a', '@issue;;no id here\n')]);
      expect(errors.some(e => e.includes('malformed `@issue` marker'))).toBe(true);
    });
  });

  it('detects duplicate ids across notes', () => {
    const errors = validateExperiments([
      note('a', { status: 'completed', id: 'EXP-001' }),
      note('b', { status: 'completed', id: 'EXP-001' }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Duplicate `id: EXP-001`');
    expect(errors[0]).toContain('a');
    expect(errors[0]).toContain('b');
  });

  it('allows distinct ids and ignores blank ids', () => {
    expect(
      validateExperiments([
        note('a', { status: 'completed', id: 'EXP-001' }),
        note('b', { status: 'completed', id: 'EXP-002' }),
        note('c', { status: 'completed' }),
      ])
    ).toEqual([]);
  });

  it('flags a labnote_id shared by notes of different experiments', () => {
    const withIds = (dir: string, ids: string[]): ValidatedNote => ({
      path: `labnote/${dir}/README.labnote.md`,
      frontMatter: { experiment_type: 'labnote', status: 'in-progress' },
      sources: ids.map((noteId, i) => ({ path: `labnote/${dir}/00${i}_WD010_X.labnote.md`, body: '', bodyLineOffset: 0, noteId })),
    });
    const errors = validateExperiments([withIds('001_A', ['LN-7K3M9QX2']), withIds('002_B', ['LN-AAAAAAAA', 'LN-7K3M9QX2'])]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Duplicate `labnote_id: LN-7K3M9QX2`');
    expect(errors[0]).toContain('labnote/001_A/000_WD010_X.labnote.md, labnote/002_B/001_WD010_X.labnote.md');
  });

  it('ignores notes that are not experiment_type: labnote', () => {
    expect(
      validateExperiments([
        { path: 'x', frontMatter: { experiment_type: 'other' }, sources: [] },
      ])
    ).toEqual([]);
  });
});

// A mistyped marker opens no issue and reports nothing, so the researcher
// believes a discussion was raised when it was not. These rules are the only
// thing that surfaces that.
describe('validateExperiments — @issue markers', () => {
  const ok = { status: 'in-progress' };

  it('accepts well-formed markers', () => {
    const body = '## Results\n@issue;ISS-a1;재현 조건 확인\n@issue;ISS-b2;다른 논의';
    expect(validateExperiments([note('a', ok, body)])).toEqual([]);
  });

  it('flags a marker written without an ID and points at the fix', () => {
    const errors = validateExperiments([note('a', ok, '@issue;수율이 재현되지 않음')]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('malformed `@issue` marker');
    expect(errors[0]).toContain('missing marker ID');
    expect(errors[0]).toContain('Insert issue marker');
  });

  it('flags a marker with no topic sentence', () => {
    const errors = validateExperiments([note('a', ok, '@issue;ISS-a1;')]);
    expect(errors[0]).toContain('missing topic sentence');
  });

  it('cites the line in the file, not in the body', () => {
    // Body line 2, with 4 front-matter lines stripped, is file line 6.
    const errors = validateExperiments([note('a', ok, 'prose\n@issue;broken', 4)]);
    expect(errors[0]).toContain('a:6:');
  });

  it('rejects a marker ID reused within one note', () => {
    const errors = validateExperiments([note('a', ok, '@issue;ISS-a1;첫째\n@issue;ISS-a1;둘째')]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate marker ID `ISS-a1`');
  });

  it('allows the same marker ID in different experiments, since issues are namespaced', () => {
    expect(
      validateExperiments([
        note('a', { ...ok, id: 'EXP-001' }, '@issue;ISS-a1;x'),
        note('b', { ...ok, id: 'EXP-002' }, '@issue;ISS-a1;x'),
      ])
    ).toEqual([]);
  });

  // The run is written in the workflow notes, so that is where most markers
  // live. Validating only the README would leave them silently unchecked.
  it('checks markers in workflow notes, not just the README', () => {
    const errors = validateExperiments([
      {
        path: 'labnote/001_A/README.labnote.md',
        frontMatter: { experiment_type: 'labnote', ...ok },
        sources: [
          { path: 'labnote/001_A/README.labnote.md', body: '', bodyLineOffset: 0 },
          { path: 'labnote/001_A/01_WD001_Design.labnote.md', body: '@issue;깨진마커', bodyLineOffset: 3 },
        ],
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('labnote/001_A/01_WD001_Design.labnote.md:4:');
  });

  // The issue identifier is `<experiment>/<marker ID>`, so a reused ID across
  // two files of one experiment would quietly target a single issue.
  it('rejects a marker ID reused across two notes of one experiment', () => {
    const errors = validateExperiments([
      {
        path: 'labnote/001_A/README.labnote.md',
        frontMatter: { experiment_type: 'labnote', ...ok },
        sources: [
          { path: 'labnote/001_A/README.labnote.md', body: '@issue;ISS-a1;첫째', bodyLineOffset: 0 },
          { path: 'labnote/001_A/01_WD001_Design.labnote.md', body: '@issue;ISS-a1;둘째', bodyLineOffset: 0 },
        ],
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate marker ID `ISS-a1`');
    expect(errors[0]).toContain('already used at labnote/001_A/README.labnote.md:1');
  });
});

// The pre-commit hook runs this on every commit that touches a note, so the
// large-file re-check has to be skippable: the hook already checked the staged
// files, while the re-check here scans the whole vault.
describe('run --notes-only', () => {
  beforeEach(() => {
    largeFileCheck.mockClear();
  });

  it('re-runs the vault-wide size guard by default', () => {
    run([]);
    expect(largeFileCheck).toHaveBeenCalledTimes(1);
  });

  it('skips the size guard with --notes-only', () => {
    run(['--notes-only']);
    expect(largeFileCheck).not.toHaveBeenCalled();
  });

  it('still reports a blocked file when the guard does run', () => {
    largeFileCheck.mockReturnValueOnce(1);
    expect(run([])).toBe(1);
    expect(run(['--notes-only'])).toBe(0);
  });

  // The tests run from this repo's root, which has no `labnote/` (#129).
  it('warns instead of passing when there is no note to check', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(run(['--notes-only'])).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('검증할 실험 노트가 없습니다'));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('✅'));
    } finally {
      log.mockRestore();
    }
  });
});

// #208: `discuss: maybe` opened no issue and nothing said so.
describe('validationWarnings', () => {
  it('warns about a discuss value that reads as neither on nor off, without failing', () => {
    const notes = [
      note('labnote/001_A/README.labnote.md', { status: 'in-progress', discuss: 'maybe' }),
      note('labnote/002_B/README.labnote.md', { status: 'in-progress', discuss: 'yes' }),
      note('labnote/003_C/README.labnote.md', { status: 'in-progress' }),
    ];
    const warnings = validationWarnings(notes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('labnote/001_A/README.labnote.md');
    expect(warnings[0]).toContain('discuss: maybe');
    expect(validateExperiments(notes)).toEqual([]);
  });
});
