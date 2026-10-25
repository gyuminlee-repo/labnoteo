/**
 * Pure reconciliation logic of the "Setup research automation" scaffold.
 *
 * `upsertManagedBlock` guards the one file the plugin shares with the user
 * (`AGENTS.md`): re-running the command must refresh ONLY the labnoteo marker
 * block and never clobber rules the user wrote around it. `appendMissingLines`
 * guards `.gitignore`/`CLAUDE.md` merges the same way.
 */
import { describe, it, expect } from 'vitest';
import {
  appendMissingLines,
  findStaleIgnoreLines,
  upsertManagedBlock,
} from '../../src/scaffold/scaffold';
import {
  LEGACY_ASSET_PATHS,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  SCAFFOLD_ASSETS,
  STALE_IGNORE_LINES,
} from '../../src/scaffold/assets';

const MARKERS = { begin: MANAGED_BLOCK_BEGIN, end: MANAGED_BLOCK_END };

describe('upsertManagedBlock', () => {
  it('creates the block as the whole content for a new/empty file', () => {
    const out = upsertManagedBlock('', 'rule A\nrule B', MARKERS);
    expect(out).toBe(`${MANAGED_BLOCK_BEGIN}\nrule A\nrule B\n${MANAGED_BLOCK_END}\n`);
  });

  it('appends the block to an existing file without markers, preserving content', () => {
    const existing = '# My own agent rules\n\n- never touch secrets\n';
    const out = upsertManagedBlock(existing, 'labnoteo rules', MARKERS);
    expect(out.startsWith(existing)).toBe(true);
    expect(out).toContain(`${MANAGED_BLOCK_BEGIN}\nlabnoteo rules\n${MANAGED_BLOCK_END}`);
  });

  it('replaces only the marker span, preserving text before and after', () => {
    const existing = [
      'user intro',
      MANAGED_BLOCK_BEGIN,
      'old rules',
      MANAGED_BLOCK_END,
      'user outro',
    ].join('\n');
    const out = upsertManagedBlock(existing, 'new rules', MARKERS);
    expect(out).toBe(
      ['user intro', MANAGED_BLOCK_BEGIN, 'new rules', MANAGED_BLOCK_END, 'user outro'].join('\n')
    );
  });

  it('is idempotent: applying the same inner content twice changes nothing', () => {
    const once = upsertManagedBlock('# mine\n', 'stable rules', MARKERS);
    const twice = upsertManagedBlock(once, 'stable rules', MARKERS);
    expect(twice).toBe(once);
  });

  it('handles regex special characters in the markers (parentheses, dashes)', () => {
    // The default markers contain `(`/`)`; replacement must still match them.
    const seeded = upsertManagedBlock('', 'v1', MARKERS);
    const updated = upsertManagedBlock(seeded, 'v2', MARKERS);
    expect(updated).toContain('v2');
    expect(updated).not.toContain('v1');
  });

  it('keeps `$` sequences in the new content literal', () => {
    const seeded = upsertManagedBlock('intro\n', 'v1', MARKERS);
    const inner = "escape `<`·`$`와 `~~`, $& and $'";
    const updated = upsertManagedBlock(seeded, inner, MARKERS);
    expect(updated).toBe(seeded.replace('\nv1\n', () => `\n${inner}\n`));
  });
});

describe('appendMissingLines', () => {
  it('appends only lines the file does not already contain', () => {
    const out = appendMissingLines('a\nb\n', 'b\nc\n');
    expect(out).toBe('a\nb\n\nc\n');
  });

  it('does not duplicate the CLAUDE.md @AGENTS.md import on re-run', () => {
    const existing = '# my claude notes\n@AGENTS.md\n';
    expect(appendMissingLines(existing, '@AGENTS.md\n')).toBe(existing);
  });

  it('creates the import when the user file lacks it', () => {
    const out = appendMissingLines('# my claude notes\n', '@AGENTS.md\n');
    expect(out).toContain('@AGENTS.md');
  });
});

describe('SCAFFOLD_ASSETS registry', () => {
  const byPath = new Map(SCAFFOLD_ASSETS.map(a => [a.vaultPath, a]));

  it('installs AGENTS.md as a managed block and CLAUDE.md as an append-only pointer', () => {
    expect(byPath.get('AGENTS.md')?.merge).toBe('managed-block');
    expect(byPath.get('CLAUDE.md')?.merge).toBe('append-missing');
    expect(byPath.get('CLAUDE.md')?.content).toBe('@AGENTS.md\n');
  });

  it('no longer ships the server-side AI gate assets (local agent replaces them)', () => {
    for (const gone of [
      'scripts/issue-gate.mjs',
      'scripts/wiki-propose.mjs',
      'ai/prompts/issue-gate.md',
      'ai/prompts/wiki-propose.md',
      'ai/schemas/issue-gate.schema.json',
      'ai/schemas/wiki-propose.schema.json',
    ]) {
      expect(byPath.has(gone)).toBe(false);
    }
  });

  it('keeps the deterministic server-side pipeline', () => {
    for (const kept of [
      '.labnoteo/scripts/validate.mjs',
      '.labnoteo/scripts/issue-sync.mjs',
      '.github/workflows/validate.yml',
      '.github/workflows/experiment-issues.yml',
      '.github/workflows/wiki-sync.yml',
    ]) {
      expect(byPath.has(kept)).toBe(true);
    }
  });

  it('ships both user docs: researcher quick start and admin setup guide', () => {
    expect(byPath.has('QUICKSTART.md')).toBe(true);
    expect(byPath.has('.labnoteo/SETUP.md')).toBe(true);
  });

  it('keeps in the vault root only what a human or an agent opens there', () => {
    // `.github/` is GitHub's own path, AGENTS.md/CLAUDE.md are only read from
    // the repo root, and the rest is what researchers actually open.
    for (const root of [
      'QUICKSTART.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.gitignore',
      'wiki-staging/Home.md',
    ]) {
      expect(byPath.has(root)).toBe(true);
    }
  });

  it('never lists a currently-installed path as a legacy leftover', () => {
    // A path in both lists would be written and then deleted in the same run.
    const legacy = new Set(LEGACY_ASSET_PATHS);
    expect(SCAFFOLD_ASSETS.filter(a => legacy.has(a.vaultPath)).map(a => a.vaultPath)).toEqual([]);
  });
});

describe('.gitignore snippet', () => {
  const snippet = SCAFFOLD_ASSETS.find(a => a.vaultPath === '.gitignore')?.content ?? '';
  const lines = snippet.split(/\r?\n/).map(l => l.trim());

  it('scopes the agent ignores so the skill negations below can apply', () => {
    // Excluding `.claude/` outright stops Git descending into it, which makes
    // `!.claude/skills/` dead regardless of ordering — and agent skills then
    // silently never get committed.
    for (const blanket of STALE_IGNORE_LINES) {
      expect(lines).not.toContain(blanket);
    }
    expect(lines).toContain('.claude/*');
    expect(lines).toContain('.agents/*');
  });

  it('re-includes the skill directories', () => {
    expect(lines).toContain('!.claude/skills/');
    expect(lines).toContain('!.agents/skills/');
  });

  it("excludes the Copilot plugin's conversations but keeps its shared skills (#34)", () => {
    // Copilot saves chats under `copilot/copilot-conversations/`. A blanket
    // `copilot/` would also make the skills negation dead, and a negation
    // placed before the exclusion is overridden by it.
    expect(lines).not.toContain('copilot/');
    const exclude = lines.indexOf('copilot/*');
    const keepSkills = lines.indexOf('!copilot/skills/');
    expect(exclude).toBeGreaterThanOrEqual(0);
    expect(keepSkills).toBeGreaterThan(exclude);
  });

  it('excludes plugin settings, which hold the LLM API key in plain text', () => {
    // `.obsidian` stays under version control for the shared settings, so the
    // one file carrying a secret has to be named explicitly.
    expect(lines).toContain('.obsidian/plugins/*/data.json');
  });

  it('excludes the unmatched scan queue, which holds raw photos', () => {
    expect(lines).toContain('_labnote-scans/');
  });
});

describe('findStaleIgnoreLines', () => {
  it('finds the blanket ignores an upgraded vault still carries', () => {
    const existing = '*.bam\n.claude/\n.agents/\n';
    expect(findStaleIgnoreLines(existing, STALE_IGNORE_LINES)).toEqual(['.claude/', '.agents/']);
  });

  it('does not flag the scoped/negated lines we install (would warn every run)', () => {
    const existing = '.claude/*\n!.claude/skills/\n.agents/*\n!.agents/skills/\n';
    expect(findStaleIgnoreLines(existing, STALE_IGNORE_LINES)).toEqual([]);
  });

  it('returns nothing for a file without any agent ignores', () => {
    expect(findStaleIgnoreLines('*.bam\nraw-data/\n', STALE_IGNORE_LINES)).toEqual([]);
  });
});
