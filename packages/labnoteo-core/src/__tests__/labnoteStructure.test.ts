// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// `getExperimentDir` derives which `labnote/###_Name` experiment a path belongs
// to; every sample/workflow write is scoped by it, so the boundaries are pinned
// here. These cases were consolidated from the plugin's former
// `labnoteDirFromPath` test when the logic moved into core.
import {
  getExperimentDir,
  getExperimentLabsamplesFolder,
  generateReadmeContent,
  createLabnoteStructure,
  commandName,
} from '../lib/labnoteStructure';
import { parseFrontMatterYaml } from '../sections/frontMatter';
import { isValidStatus } from '../lib/experimentStatus';

describe('getExperimentDir', () => {
  it('extracts the experiment folder from a note inside it', () => {
    expect(getExperimentDir('labnote/001_Test/README.labnote.md')).toBe('labnote/001_Test');
  });

  it('works for a note nested deeper in the experiment', () => {
    expect(getExperimentDir('labnote/001_Test/resources/labsamples/DNA.json')).toBe(
      'labnote/001_Test'
    );
  });

  it('keeps the prefix when labnote is not at the vault root', () => {
    expect(getExperimentDir('projects/2026/labnote/012_Assay/note.md')).toBe(
      'projects/2026/labnote/012_Assay'
    );
  });

  it('uses the last labnote segment when the name repeats', () => {
    expect(getExperimentDir('labnote/001_A/labnote/002_B/note.md')).toBe(
      'labnote/001_A/labnote/002_B'
    );
  });

  it('normalises separators and redundant segments', () => {
    expect(getExperimentDir('labnote//001_Test/./README.labnote.md')).toBe('labnote/001_Test');
  });

  it('normalises Windows backslash separators', () => {
    expect(getExperimentDir('labnote\\001_Test\\README.labnote.md')).toBe('labnote/001_Test');
  });

  it('returns undefined when there is no labnote segment', () => {
    expect(getExperimentDir('notes/daily/2026-09-07.md')).toBeUndefined();
  });

  it('returns undefined for the labnote folder itself (no experiment yet)', () => {
    expect(getExperimentDir('labnote')).toBeUndefined();
  });

  it.each([
    'labnote/Test/README.md', // no numeric prefix
    'labnote/1_Test/README.md', // too few digits
    'labnote/0001_Test/README.md', // too many digits before the underscore
    'labnote/001-Test/README.md', // wrong separator
  ])('returns undefined for a folder not matching ###_Name: %s', p => {
    expect(getExperimentDir(p)).toBeUndefined();
  });

  it('accepts the experiment folder path itself', () => {
    expect(getExperimentDir('labnote/001_Test')).toBe('labnote/001_Test');
  });
});

describe('getExperimentLabsamplesFolder', () => {
  it('appends resources/labsamples to the experiment dir', () => {
    expect(getExperimentLabsamplesFolder('labnote/001_Test/README.labnote.md')).toBe(
      'labnote/001_Test/resources/labsamples'
    );
  });

  it('resolves from a nested path within the experiment', () => {
    expect(getExperimentLabsamplesFolder('labnote/001_Test/images/a.png')).toBe(
      'labnote/001_Test/resources/labsamples'
    );
  });

  it('returns undefined for a path outside any experiment', () => {
    expect(getExperimentLabsamplesFolder('notes/a.md')).toBeUndefined();
  });
});

describe('generateReadmeContent', () => {
  it('seeds the additive status/project frontmatter (no id/issue)', () => {
    const md = generateReadmeContent('My Experiment', 'Alice');
    const { frontMatter } = parseFrontMatterYaml(md);

    // Existing fields are still present…
    expect(frontMatter.title).toBe('My Experiment');
    expect(frontMatter.author).toBe('Alice');
    expect(frontMatter.experiment_type).toBe('labnote');
    expect(frontMatter.sample_tracking).toBe('yes');
    expect(typeof frontMatter.created_date).toBe('string');
    expect(typeof frontMatter.last_updated_date).toBe('string');

    // …plus the new Phase 1 additive metadata.
    expect(frontMatter.status).toBe('planned');
    expect(isValidStatus(frontMatter.status as string)).toBe(true);
    // `project` is emitted empty (parses to null) — present but unset.
    expect('project' in frontMatter).toBe(true);
    expect(frontMatter.project).toBeNull();

    // `id`/`issue` are intentionally NOT part of the default template.
    expect('id' in frontMatter).toBe(false);
    expect('issue' in frontMatter).toBe(false);
  });

  it('emits the literal status/project lines via serializeFrontMatterEntry', () => {
    const md = generateReadmeContent('Assay');
    expect(md).toContain('\nstatus: planned\n');
    expect(md).toContain('\nproject: \n');
  });

  it('preserves the experiment template body sections', () => {
    const md = generateReadmeContent('Assay');
    const { body } = parseFrontMatterYaml(md);
    expect(body).toContain('## 🎯 Experiment Objective');
    expect(body).toContain('## 🗂️ Related Workflows');
    expect(body).toContain('## Summary and Discussion');
  });

  // #23: the checklist is appended to the section itself; there are no markers.
  it('does not tell the user to write between markers that do not exist', () => {
    const md = generateReadmeContent('Assay');
    expect(md).not.toMatch(/between the markers/i);
    expect(md).toContain('added to this section automatically');
  });

  // #38: a Korean UI shows `워크플로 생성`, so the hint must name it too.
  it('cites only the English command name without a Korean locale', () => {
    for (const md of [
      generateReadmeContent('Assay'),
      generateReadmeContent('Assay', '', { locale: 'en' }),
      generateReadmeContent('Assay', '', { locale: 'kok' }),
    ]) {
      expect(md).toContain('run `Create workflow`;');
      expect(md).not.toContain('워크플로 생성');
    }
  });

  it('adds the Korean command name under a Korean locale', () => {
    for (const locale of ['ko', 'ko-KR', 'KO']) {
      const md = generateReadmeContent('Assay', '', { locale });
      expect(md).toContain('run `Create workflow` (`워크플로 생성`);');
    }
  });

  it('threads the locale through createLabnoteStructure', () => {
    const s = createLabnoteStructure('.', 'Assay', [], undefined, { locale: 'ko' });
    expect(s.readmeContent).toContain('(`워크플로 생성`)');
  });
});

describe('commandName', () => {
  it('formats the palette name for the locale', () => {
    expect(commandName('Create workflow', '워크플로 생성')).toBe('`Create workflow`');
    expect(commandName('Create workflow', '워크플로 생성', 'ko-KR')).toBe(
      '`Create workflow` (`워크플로 생성`)'
    );
  });
});
