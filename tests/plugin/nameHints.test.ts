/**
 * #213: the name prompts count what goes into the file or folder name and
 * warn past the cap without blocking.
 */
import { describe, it, expect } from 'vitest';
import { listUnitOpBlocks } from '@labnoteo/core';
import { experimentTitleHint, unitOpAliasHint, workflowAliasHint } from '../../src/commands';

const host = { t: (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s) };

describe('name prompt hints', () => {
  it('counts an experiment title against the folder cap', () => {
    const hint = experimentTitleHint(host);
    expect(hint('GFP assay')).toEqual({
      text: '9/60 characters in the folder name. Anything longer is cut from the folder name only; the experiment title keeps it all.',
      warn: false,
    });
    expect(hint('a'.repeat(61)).warn).toBe(true);
  });

  it('counts a workflow alias against the room the workflow leaves', () => {
    const hint = workflowAliasHint(host, 'WD010', 'Design');
    const room = 80 - 'WD010_Design_'.length;
    expect(hint('1차 설계').text).toBe(
      `5/${room} characters in the file name. Anything longer is cut from the file name only; the workflow title and checklist keep it all.`
    );
    expect(hint('가'.repeat(room)).warn).toBe(false);
    expect(hint('가'.repeat(room + 1)).warn).toBe(true);
  });

  it('says when a long workflow name leaves no room', () => {
    const hint = workflowAliasHint(host, 'WX999', 'Long name '.repeat(9));
    expect(hint('').text).toContain("won't fit in the file name");
    expect(hint('').warn).toBe(false);
    expect(hint('x').warn).toBe(true);
  });

  it('warns when another workflow of the ID has the same alias, empty included (#297)', () => {
    const files = ['001_WD010_Design_1차_설계.labnote.md', '002_WD010_Design.labnote.md', 'README.labnote.md'];
    const hint = workflowAliasHint(host, 'WD010', 'Design', files);
    expect(hint('1차 설계')).toEqual({
      text: '001_WD010_Design_1차_설계.labnote.md already has this ID and alias, so the two would read the same in the README checklist. Give this one its own alias to tell them apart.',
      warn: true,
    });
    expect(hint('').text).toContain('002_WD010_Design.labnote.md already has');
    expect(hint('2차 설계').warn).toBe(false);
    expect(workflowAliasHint(host, 'WD020', 'Design', files)('1차 설계').warn).toBe(false);
  });

  it('only counts a unit operation alias', () => {
    expect(unitOpAliasHint(host)(' 1차 37도 ')).toEqual({ text: '6 characters · no limit (not used in a file name)' });
  });

  it('flags a unit operation of this ID with the same alias already in the note (#339)', () => {
    const blocks = listUnitOpBlocks(
      [
        '## [WB020 Phage Library] 파지라이브러리',
        '### [UHW265 Sanger Sequencing] 무작위 클론',
        'body',
        '### [UHW240 SDS-PAGE]',
      ].join('\n')
    );
    const hint = unitOpAliasHint(host, { id: 'UHW265', name: 'Sanger Sequencing' }, blocks);
    expect(hint(' 무작위  클론 ')).toEqual({
      text: '[UHW265 Sanger Sequencing] 무작위 클론 is already in this note, so the two would read the same in the headings and the table of contents. Give this one its own alias to tell them apart.',
      warn: true,
    });
    expect(hint('2차 클론').warn).toBeUndefined();
    const sds = unitOpAliasHint(host, { id: 'UHW240', name: 'SDS-PAGE' }, blocks);
    expect(sds('').text).toContain('[UHW240 SDS-PAGE] is already');
    expect(sds('순도').warn).toBeUndefined();
  });
});
