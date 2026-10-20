// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
//
// #201, #166: a unit operation command says why the open note takes no unit
// operation before its picker opens, not after a choice was made.
import { diagnoseWorkflowPath } from '../lib/workflowStructure';
import { workflowPathProblem } from '../commands/insertUnitOperation';

const t = (s: string, ...args: string[]) => args.reduce((acc, a, i) => acc.replace(`{${i}}`, a), s);

describe('diagnoseWorkflowPath', () => {
  it('accepts a workflow note directly in an experiment folder', () => {
    expect(diagnoseWorkflowPath('labnote/001_E/001_WD010_Design.labnote.md')).toEqual({ kind: 'ok' });
  });

  it('tells the experiment README apart', () => {
    expect(diagnoseWorkflowPath('labnote/001_E/README.labnote.md')).toEqual({
      kind: 'readme',
      folder: 'labnote/001_E',
    });
  });

  it('names a note in an experiment that is no workflow', () => {
    expect(diagnoseWorkflowPath('labnote/001_E/notes.md')).toEqual({ kind: 'notWorkflow', folder: 'labnote/001_E' });
    expect(diagnoseWorkflowPath('labnote/001_E/Design.labnote.md').kind).toBe('notWorkflow');
    expect(diagnoseWorkflowPath('labnote/001_E/sub/001_X.labnote.md').kind).toBe('notWorkflow');
  });

  it('finds an experiment moved into a grouping folder', () => {
    expect(diagnoseWorkflowPath('labnote/Group/001_E/001_WD010_Design.labnote.md')).toEqual({
      kind: 'nested',
      folder: 'labnote/Group/001_E',
    });
  });

  it('finds an experiment folder without its number', () => {
    expect(diagnoseWorkflowPath('labnote/E/001_WD010_Design.labnote.md')).toEqual({
      kind: 'noPrefix',
      folder: 'labnote/E',
    });
  });

  it('reports a note outside labnote/', () => {
    expect(diagnoseWorkflowPath('notes/001_WD010_Design.labnote.md')).toEqual({ kind: 'outside' });
    expect(diagnoseWorkflowPath('labnote/loose.md')).toEqual({ kind: 'outside' });
  });
});

describe('workflowPathProblem', () => {
  it('is undefined for a workflow note', () => {
    expect(workflowPathProblem({ t }, 'labnote/001_E/001_WD010_Design.labnote.md')).toBeUndefined();
  });

  it('points from the README to a workflow note', () => {
    expect(workflowPathProblem({ t }, 'labnote/001_E/README.labnote.md')).toContain('Create workflow');
  });

  it('names the folder to move back', () => {
    expect(workflowPathProblem({ t }, 'labnote/Group/001_E/001_W.labnote.md')).toContain('"001_E"');
  });

  it('names the folder that lost its number', () => {
    expect(workflowPathProblem({ t }, 'labnote/E/001_W.labnote.md')).toContain('"E"');
  });
});
