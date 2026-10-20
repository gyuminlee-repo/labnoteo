/**
 * #213: the name prompts count what goes into the file or folder name and
 * warn past the cap without blocking.
 */
import { describe, it, expect } from 'vitest';
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

  it('only counts a unit operation alias', () => {
    expect(unitOpAliasHint(host)(' 1차 37도 ')).toEqual({ text: '6 characters · no limit (not used in a file name)' });
  });
});
