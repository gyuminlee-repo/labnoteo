// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// #213: the character counts the name prompts show must match where
// createLabnoteStructure / createWorkflowFileName actually cut.
import {
  createLabnoteStructure,
  experimentTitleBudget,
  experimentTitleLength,
} from '../lib/labnoteStructure';
import { createWorkflowFileName, workflowAliasBudget, workflowAliasLength } from '../lib/workflowStructure';
import { WORKFLOWS_CATALOG } from '../catalog';

const folderTitle = (title: string) =>
  createLabnoteStructure('', title, []).labnoteFolder.replace(/^labnote\/001_/, '');

describe('experiment title budget', () => {
  it('is the folder cap', () => {
    expect(experimentTitleBudget()).toBe(60);
  });

  it.each([
    ['ASCII', 'a'.repeat(70)],
    ['Korean with spaces', `${'가나다 '.repeat(20)}`],
    ['word-ending plus', `${'IND+ '.repeat(15)}`],
  ])('counts what goes into the folder name (%s)', (_label, title) => {
    const length = experimentTitleLength(title);
    const budget = experimentTitleBudget();
    expect(Array.from(folderTitle(title)).length).toBeLessThanOrEqual(Math.min(length, budget));
    expect(Array.from(folderTitle(title)).length).toBeGreaterThanOrEqual(Math.min(length, budget) - 1);
  });

  it('counts sanitized characters, not typed ones', () => {
    expect(experimentTitleLength('  GFP / assay  ')).toBe(Array.from('GFP_assay').length);
    expect(experimentTitleLength('IND+')).toBe(Array.from('IND_plus').length);
    expect(folderTitle('a'.repeat(60))).toBe('a'.repeat(60));
  });
});

describe('workflow alias budget', () => {
  const wf = { id: 'WD010', name: 'Design', description: '' };
  const aliasPart = (alias: string) =>
    createWorkflowFileName('001', wf, alias).replace(/^001_WD010_Design_?/, '').replace(/\.labnote\.md$/, '');

  it('is what the file name leaves after ID_name_', () => {
    expect(workflowAliasBudget('WD010', 'Design')).toBe(80 - 'WD010_Design_'.length);
  });

  it('keeps an alias within the budget whole and cuts a longer one there', () => {
    const budget = workflowAliasBudget('WD010', 'Design');
    expect(aliasPart('가'.repeat(budget))).toBe('가'.repeat(budget));
    expect(aliasPart('가'.repeat(budget + 5))).toBe('가'.repeat(budget));
    expect(workflowAliasLength(' 1차 설계+ ')).toBe(Array.from('1차_설계_plus').length);
  });

  it('is 0 when the catalog name alone fills the file name', () => {
    expect(workflowAliasBudget('WX999', 'Long name '.repeat(9))).toBe(0);
  });

  it('leaves room in every bundled workflow', () => {
    for (const w of WORKFLOWS_CATALOG.workflows) expect(workflowAliasBudget(w.id, w.name)).toBeGreaterThanOrEqual(25);
  });
});
