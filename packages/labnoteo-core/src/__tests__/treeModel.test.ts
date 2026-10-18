// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  buildExperimentTree,
  buildWorkflowTree,
  buildSampleTree,
  filterSampleTree,
  type WorkflowTreeData,
} from '../tree/treeModel';
import { MemFileSystem } from '../fs/memFileSystem';
import type { WorkflowItem, UnitOperationItem } from '../lib/workflowDataLoader';

describe('buildWorkflowTree', () => {
  const data: WorkflowTreeData = {
    workflows: [
      { id: 'WD010', name: 'Design', description: 'd', category: 'Design' },
      { id: 'WB010', name: 'Build', description: 'b', category: 'Build' },
      { id: 'WD020', name: 'Design2', description: '', category: 'Design' },
    ] as WorkflowItem[],
    hwUnitOps: [
      { id: 'UHW010', name: 'Spin', description: 'x', equipment: 'Centrifuge' },
    ] as UnitOperationItem[],
    swUnitOps: [
      { id: 'USW010', name: 'Align', description: 'y', software: 'BWA' },
    ] as UnitOperationItem[],
  };

  it('produces three roots with counts', () => {
    const [wf, hw, sw] = buildWorkflowTree(data);
    expect(wf.label).toBe('Workflows [3]');
    expect(hw.label).toBe('HW Unit Operations [1]');
    expect(sw.label).toBe('SW Unit Operations [1]');
    expect(wf.kind).toBe('workflowRoot');
  });

  it('orders categories by DBTL and nests workflows', () => {
    const [wf] = buildWorkflowTree(data);
    const cats = wf.children!.map(c => c.label);
    expect(cats).toEqual(['Design [2]', 'Build [1]']);
    expect(wf.children![0].children!.map(w => w.label)).toEqual([
      'WD010: Design',
      'WD020: Design2',
    ]);
  });

  it('embeds equipment/software tooltip on unit operations', () => {
    const [, hw, sw] = buildWorkflowTree(data);
    expect(hw.children![0].tooltip).toContain('Equipment: Centrifuge');
    expect(sw.children![0].tooltip).toContain('Software: BWA');
  });

  it('sorts unknown categories AFTER the known DBTL order (not before Design)', () => {
    const withUnknown: WorkflowTreeData = {
      workflows: [
        { id: 'WX010', name: 'Misc', description: '', category: 'Zzz' },
        { id: 'WB010', name: 'Build', description: '', category: 'Build' },
        { id: 'WD010', name: 'Design', description: '', category: 'Design' },
        { id: 'WU010', name: 'Uncat', description: '', category: 'Uncategorized' },
      ] as WorkflowItem[],
      hwUnitOps: [],
      swUnitOps: [],
    };
    const [wf] = buildWorkflowTree(withUnknown);
    const cats = wf.children!.map(c => c.label);
    // Design/Build first (DBTL order), then unknowns alphabetically.
    expect(cats).toEqual(['Design [1]', 'Build [1]', 'Uncategorized [1]', 'Zzz [1]']);
  });
});

describe('buildSampleTree', () => {
  it('builds scope -> type -> sample -> detail levels from disk', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      '/local/DNA.json',
      JSON.stringify({
        'DNA-1': {
          type: 'DNA',
          alias: 'plasmidA',
          descriptions: ['first'],
          sources: [],
        },
      })
    );

    const [local, global] = await buildSampleTree(
      fs,
      { local: '/local', global: '/global' },
      ['DNA', 'RNA']
    );

    expect(local.label).toBe('Samples (Local)');
    expect(global.label).toBe('Samples (Global)');

    const dnaType = local.children!.find(c => c.label.startsWith('DNA'))!;
    expect(dnaType.label).toBe('DNA [1]');
    expect(dnaType.color).toBeTruthy();

    const sample = dnaType.children![0];
    expect(sample.label).toBe('DNA-1 | plasmidA');
    expect(sample.children!.map(d => d.label)).toEqual([
      'alias: plasmidA',
      'description: first',
    ]);

    // Empty type shows a placeholder leaf.
    const rnaType = local.children!.find(c => c.label.startsWith('RNA'))!;
    expect(rnaType.label).toBe('RNA [0]');
    expect(rnaType.children![0].label).toBe('No samples');
  });

  // #64: a vault-root note's local folder is the global one.
  it('lists samples once, under Global, when both scopes are the same folder', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      'resources/labsamples/DNA.json',
      JSON.stringify({ 'DNA-1': { type: 'DNA', alias: null, descriptions: [], sources: [] } })
    );

    const [local, global] = await buildSampleTree(
      fs,
      { local: './resources/labsamples', global: 'resources/labsamples' },
      ['DNA']
    );

    expect(local.children!.map(c => c.label)).toEqual(['DNA [0]']);
    expect(local.children![0].payload).toEqual({ scope: 'local', type: 'DNA' });
    expect(global.children!.map(c => c.label)).toEqual(['DNA [1]']);
    // #111: the view replaces the empty Local section with a note.
    expect(local.payload).toEqual({ scope: 'local', sameFolder: true });
    expect(global.payload).toEqual({ scope: 'global' });
  });
});

describe('filterSampleTree', () => {
  async function tree() {
    const fs = new MemFileSystem();
    await fs.write(
      '/local/DNA.json',
      JSON.stringify({
        'DNA-1': { type: 'DNA', alias: 'plasmidA', descriptions: ['promoter part'], sources: [] },
        'DNA-2': { type: 'DNA', alias: 'vectorB', descriptions: ['backbone'], sources: [], location: 'Freezer-2 / Box-3' },
      })
    );
    return buildSampleTree(fs, { local: '/local', global: '/global' }, ['DNA', 'RNA']);
  }

  it('returns the input unchanged (reference-equal) for an empty query', async () => {
    const nodes = await tree();
    expect(filterSampleTree(nodes, '   ')).toBe(nodes);
  });

  it('matches on id, alias, description and location', async () => {
    const nodes = await tree();

    const byAlias = filterSampleTree(nodes, 'vectorb');
    const dnaAlias = byAlias[0].children!.find(c => c.label.startsWith('DNA'))!;
    expect(dnaAlias.label).toBe('DNA [1]');
    expect(dnaAlias.children!.map(s => s.label)).toEqual(['DNA-2 | vectorB']);

    const byDesc = filterSampleTree(nodes, 'promoter');
    expect(byDesc[0].children![0].children!.map(s => s.label)).toEqual(['DNA-1 | plasmidA']);

    const byLocation = filterSampleTree(nodes, 'box-3');
    expect(byLocation[0].children![0].children!.map(s => s.label)).toEqual(['DNA-2 | vectorB']);

    const byId = filterSampleTree(nodes, 'dna-1');
    expect(byId[0].children![0].children!.map(s => s.label)).toEqual(['DNA-1 | plasmidA']);
  });

  it('drops type nodes with no matches and keeps scope roots', async () => {
    const nodes = await tree();
    const filtered = filterSampleTree(nodes, 'nothing-matches');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].label).toBe('Samples (Local)');
    expect(filtered[0].children).toEqual([]);
  });
});

// #128: the vault's experiments, by status, in the workflow view.
describe('buildExperimentTree', () => {
  const tree = buildExperimentTree(
    [
      { folder: 'labnote/010_Later', title: 'Later run', status: 'planned' },
      { folder: 'labnote/002_GFP', title: 'GFP expression', status: 'planned' },
      { folder: 'labnote/003_Old', status: 'completed' },
      { folder: 'labnote/004_Draft' },
      { folder: 'labnote/005_Odd', title: '005_Odd', status: 'waiting' },
      { folder: 'labnote/001_First', title: 'First', status: 'in-progress' },
    ],
    { root: 'Experiments', noStatus: '(none)' }
  );

  it('groups by status in lifecycle order, then other values, then no status', () => {
    expect(tree.label).toBe('Experiments [6]');
    expect(tree.children!.map(g => g.label)).toEqual([
      'planned [2]',
      'in-progress [1]',
      'completed [1]',
      'waiting [1]',
      '(none) [1]',
    ]);
  });

  it('sorts experiments by folder number and labels them with the title', () => {
    const planned = tree.children![0].children!;
    expect(planned.map(e => e.label)).toEqual(['002_GFP · GFP expression', '010_Later · Later run']);
    expect(planned[0].payload).toEqual({
      folder: 'labnote/002_GFP',
      readmePath: 'labnote/002_GFP/README.labnote.md',
    });
  });

  it('shows the folder alone without a title, or one that repeats it', () => {
    const labels = tree.children!.flatMap(g => g.children!.map(e => e.label));
    expect(labels).toContain('003_Old');
    expect(labels).toContain('005_Odd');
  });

  it('has an empty root without experiments', () => {
    const empty = buildExperimentTree([]);
    expect(empty.label).toBe('Experiments [0]');
    expect(empty.children).toEqual([]);
  });
});
