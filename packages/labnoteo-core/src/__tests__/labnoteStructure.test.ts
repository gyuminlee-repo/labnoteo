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
import { EXPERIMENT_FOLDER_TITLE_MAX } from '../lib/regexUtils';
import { isValidStatus } from '../lib/experimentStatus';
import {
  copiedExperimentOrigin,
  diagnoseExperimentPath,
  experimentFolderName,
  experimentLosingLabsamples,
  experimentLosingReadme,
  nextExperimentId,
  resetCopiedExperimentReadme,
  setExperimentReadmeId,
  isSampleTrackingOff,
  isSampleTrackingOn,
  suggestExperimentFolderName,
  retryOfLink,
  retryOfLinkpath,
  setRetryOf,
} from '../lib/labnoteStructure';

// #327
describe('retry_of', () => {
  it('links the original README, shown by its number, and reads the link back', () => {
    const link = retryOfLink('labnote/061_Organoid');
    expect(link).toBe('[[labnote/061_Organoid/README.labnote|061]]');
    expect(retryOfLinkpath(link)).toBe('labnote/061_Organoid/README.labnote');
    expect(retryOfLinkpath('061_Organoid')).toBeUndefined();
    expect(retryOfLinkpath(['x'])).toBeUndefined();
  });

  it('goes after project in a new README, as valid YAML that keeps the link', () => {
    const readme = generateReadmeContent('GFP 2차');
    const out = setRetryOf(readme, retryOfLink('labnote/061_GFP'));
    const lines = out.split('\n');
    expect(lines[lines.findIndex(l => l.startsWith('project:')) + 1]).toMatch(/^retry_of: /);
    expect(parseFrontMatterYaml(out).frontMatter.retry_of).toBe('[[labnote/061_GFP/README.labnote|061]]');
    expect(out.slice(out.indexOf('\n---\n'))).toBe(readme.slice(readme.indexOf('\n---\n')));
  });

  it('replaces a retry_of already there', () => {
    const out = setRetryOf('---\ntitle: A\nretry_of: old\n---\nbody\n', '[[x|1]]');
    expect(parseFrontMatterYaml(out).frontMatter.retry_of).toBe('[[x|1]]');
    expect(out.match(/retry_of/g)).toHaveLength(1);
  });
});

// #105: an experiment README can turn sample tracking off for that experiment.
describe('isSampleTrackingOff', () => {
  it('reads no/false/off in any case, and a YAML false', () => {
    for (const v of ['no', 'No', ' off ', 'FALSE', false]) expect(isSampleTrackingOff(v)).toBe(true);
  });

  it('keeps tracking on for yes, a missing value, or anything else', () => {
    for (const v of ['yes', true, undefined, null, '', 'maybe', 0]) expect(isSampleTrackingOff(v)).toBe(false);
  });

  it('decides per experiment, under the global setting', () => {
    const readmes: Record<string, Record<string, unknown>> = {
      'labnote/001_A/README.labnote.md': { sample_tracking: 'no' },
      'labnote/002_B/README.labnote.md': { sample_tracking: 'yes' },
    };
    const read = (p: string) => readmes[p];
    expect(isSampleTrackingOn(true, 'labnote/001_A/001_WD010_X.labnote.md', read)).toBe(false);
    expect(isSampleTrackingOn(true, 'labnote/001_A/README.labnote.md', read)).toBe(false);
    expect(isSampleTrackingOn(true, 'labnote/002_B/001_WD010_X.labnote.md', read)).toBe(true);
    // Not indexed yet, or outside any experiment: the setting decides.
    expect(isSampleTrackingOn(true, 'labnote/003_C/001_WD010_X.labnote.md', read)).toBe(true);
    expect(isSampleTrackingOn(true, 'Inbox.md', read)).toBe(true);
    expect(isSampleTrackingOn(true, undefined, read)).toBe(true);
    expect(isSampleTrackingOn(false, 'labnote/002_B/001_WD010_X.labnote.md', read)).toBe(false);
  });

  it('is on in a new README', () => {
    const fm = parseFrontMatterYaml(generateReadmeContent('T')).frontMatter;
    expect(fm.sample_tracking).toBe('yes');
    expect(isSampleTrackingOff(fm.sample_tracking)).toBe(false);
  });
});

// #67: an experiment folder renamed without its number left every command
// saying only "Open a lab note first."
describe('diagnoseExperimentPath', () => {
  it('reports the experiment folder of a path inside one', () => {
    expect(diagnoseExperimentPath('labnote/020_GFP/README.labnote.md')).toEqual({
      kind: 'ok',
      folder: 'labnote/020_GFP',
    });
    expect(diagnoseExperimentPath('labnote/020_GFP', { isFolder: true })).toEqual({
      kind: 'ok',
      folder: 'labnote/020_GFP',
    });
  });

  it('spots a folder under labnote/ without the ###_ prefix', () => {
    expect(diagnoseExperimentPath('labnote/GFP/README.labnote.md')).toEqual({ kind: 'noPrefix', folder: 'labnote/GFP' });
    expect(diagnoseExperimentPath('labnote/GFP/sub/x.md')).toEqual({ kind: 'noPrefix', folder: 'labnote/GFP' });
    expect(diagnoseExperimentPath('labnote/GFP', { isFolder: true })).toEqual({ kind: 'noPrefix', folder: 'labnote/GFP' });
  });

  // #166
  it('spots an experiment folder moved into a grouping folder', () => {
    expect(diagnoseExperimentPath('labnote/과제A/068_x/README.labnote.md')).toEqual({
      kind: 'nested',
      folder: 'labnote/과제A/068_x',
    });
    expect(diagnoseExperimentPath('labnote/과제A/068_x', { isFolder: true })).toEqual({
      kind: 'nested',
      folder: 'labnote/과제A/068_x',
    });
    // A note named like a number is not a folder.
    expect(diagnoseExperimentPath('labnote/과제A/001_note.md')).toEqual({ kind: 'noPrefix', folder: 'labnote/과제A' });
  });

  it('keeps files directly in labnote/ and paths outside it as outside', () => {
    expect(diagnoseExperimentPath('labnote/README.md')).toEqual({ kind: 'outside' });
    expect(diagnoseExperimentPath('Welcome.md')).toEqual({ kind: 'outside' });
    expect(diagnoseExperimentPath('notes/GFP/x.md')).toEqual({ kind: 'outside' });
    expect(diagnoseExperimentPath('labnote', { isFolder: true })).toEqual({ kind: 'outside' });
  });
});

describe('suggestExperimentFolderName', () => {
  it('puts the old number back in front of the new name', () => {
    expect(suggestExperimentFolderName('020_GFP', 'GFP_v2')).toBe('020_GFP_v2');
    expect(suggestExperimentFolderName('020_GFP', '20GFP')).toBe('020_GFP');
    expect(suggestExperimentFolderName('020_GFP', '_GFP 발현')).toBe('020_GFP 발현');
  });

  it('gives up without an old number or a name left', () => {
    expect(suggestExperimentFolderName('GFP', 'GFP2')).toBeUndefined();
    expect(suggestExperimentFolderName('020_GFP', '020')).toBeUndefined();
  });
});

describe('copied experiment folders (#223)', () => {
  it('finds the original of a folder copied with "Make a copy"', () => {
    expect(copiedExperimentOrigin('001_효모_다중자리_삽입_1차 1')).toBe('001_효모_다중자리_삽입_1차');
    expect(copiedExperimentOrigin('002_GFP 12')).toBe('002_GFP');
    expect(copiedExperimentOrigin('001_GFP')).toBeUndefined();
    expect(copiedExperimentOrigin('001_GFP_1')).toBeUndefined();
    expect(copiedExperimentOrigin('GFP 1')).toBeUndefined();
  });

  it('names the new experiment like "Create experiment"', () => {
    expect(experimentFolderName('004', '효모 다중자리 삽입 2차')).toBe('004_효모_다중자리_삽입_2차');
  });

  it('retitles, redates, unflags and replans the README, leaving the rest', () => {
    const readme = [
      '---',
      'title: 효모 다중자리 삽입 1차',
      'author: 김연구',
      'status: needs-review',
      'id: EXP-106',
      'discuss: true',
      'created_date: 2026-10-01',
      'last_updated_date: 2026-10-10',
      '---',
      '',
      '## 🎯 Experiment Objective',
      'discuss: 본문은 그대로',
    ].join('\r\n');
    expect(resetCopiedExperimentReadme(readme, '효모 다중자리 삽입 2차', '2026-10-21')).toBe(
      [
        '---',
        'title: 효모 다중자리 삽입 2차',
        'author: 김연구',
        'status: planned',
        'id: EXP-106',
        'created_date: 2026-10-21',
        'last_updated_date: 2026-10-21',
        '---',
        '',
        '## 🎯 Experiment Objective',
        'discuss: 본문은 그대로',
      ].join('\r\n')
    );
    expect(resetCopiedExperimentReadme('본문만', 'x', '2026-10-21')).toBe('본문만');
  });

  it('gives the copy its own id or drops it (#353)', () => {
    const readme = ['---', 'title: A', 'id: EXP-106', 'status: needs-review', '---', 'id: 본문'].join('\n');
    expect(setExperimentReadmeId(readme, 'EXP-107')).toBe(
      ['---', 'title: A', 'id: EXP-107', 'status: needs-review', '---', 'id: 본문'].join('\n')
    );
    expect(setExperimentReadmeId(readme, undefined)).toBe(['---', 'title: A', 'status: needs-review', '---', 'id: 본문'].join('\n'));
    expect(setExperimentReadmeId('---\ntitle: A\n---\n', 'EXP-1')).toBe('---\ntitle: A\n---\n');
  });

  it('numbers the next id past every taken one with the same prefix (#353)', () => {
    expect(nextExperimentId('EXP-106', ['EXP-106', 'EXP-107', 'OTHER-900'])).toBe('EXP-108');
    expect(nextExperimentId('EXP-006', [])).toBe('EXP-007');
    expect(nextExperimentId('KIM-2026-9', ['KIM-2026-12'])).toBe('KIM-2026-13');
    expect(nextExperimentId('효모실험', [])).toBeUndefined();
  });
});

describe('experimentLosingReadme (#226)', () => {
  const readme = 'labnote/001_GFP/README.labnote.md';

  it('names the experiment whose README was renamed or moved away', () => {
    expect(experimentLosingReadme(readme, 'labnote/001_GFP/README.md')).toBe('labnote/001_GFP');
    expect(experimentLosingReadme(readme, 'labnote/001_GFP/archive/README.labnote.md')).toBe('labnote/001_GFP');
    expect(experimentLosingReadme(readme, 'README.labnote.md')).toBe('labnote/001_GFP');
  });

  it('ignores a README that moved with its renamed experiment, and other notes', () => {
    expect(experimentLosingReadme(readme, 'labnote/002_GFP/README.labnote.md')).toBeUndefined();
    expect(experimentLosingReadme('labnote/001_GFP/notes/README.labnote.md', 'labnote/001_GFP/notes/x.md')).toBeUndefined();
    expect(experimentLosingReadme('labnote/001_GFP/001_WD010_Design.labnote.md', 'labnote/001_GFP/x.md')).toBeUndefined();
  });
});

describe('experimentLosingLabsamples (#338)', () => {
  it('names the experiment whose sample registry folder was renamed or moved away', () => {
    expect(experimentLosingLabsamples('labnote/001_A/resources/labsamples', 'labnote/001_A/resources/labsamples_old')).toBe(
      'labnote/001_A'
    );
    expect(experimentLosingLabsamples('labnote/001_A/resources', 'labnote/001_A/resources_bak')).toBe('labnote/001_A');
    expect(experimentLosingLabsamples('labnote/001_A/resources/labsamples', 'archive/labsamples')).toBe('labnote/001_A');
  });

  it('ignores a registry that moved with its renamed experiment, and other folders', () => {
    expect(experimentLosingLabsamples('labnote/001_A/resources/labsamples', 'labnote/002_A/resources/labsamples')).toBeUndefined();
    expect(experimentLosingLabsamples('labnote/001_A/images', 'labnote/001_A/pics')).toBeUndefined();
    expect(experimentLosingLabsamples('labnote/001_A/resources/labsamples/sub', 'labnote/001_A/resources/labsamples/x')).toBeUndefined();
  });
});

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

  // #148: the folder name is cut, the README title is not.
  it('caps the title part of the folder name at EXPERIMENT_FOLDER_TITLE_MAX', () => {
    expect(EXPERIMENT_FOLDER_TITLE_MAX).toBe(60);
    const title = `${'가'.repeat(58)} 나다라`;
    const s = createLabnoteStructure('', title, []);
    expect(s.labnoteFolder).toBe(`labnote/001_${'가'.repeat(58)}_나`);
    expect(s.readmeContent).toContain(`title: ${title}\n`);
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
