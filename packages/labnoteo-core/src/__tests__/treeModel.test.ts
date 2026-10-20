// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import {
  buildExperimentTree,
  buildWorkflowTree,
  buildSampleTree,
  filterSampleTree,
  filterExperiments,
  type ExperimentEntry,
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

  it('tags and dims a discarded sample (#158)', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      '/local/DNA.json',
      JSON.stringify({
        'DNA-1': { type: 'DNA', alias: null, descriptions: [], sources: [], discarded: '2026-10-19' },
        'DNA-2': { type: 'DNA', alias: null, descriptions: [], sources: [] },
      })
    );
    const [local] = await buildSampleTree(fs, { local: '/local', global: '/global' }, ['DNA'], {
      discarded: '(폐기)',
    });
    const [gone, kept] = local.children![0].children!;
    expect(gone.label).toBe('DNA-1 (폐기)');
    expect(gone.dimmed).toBe(true);
    expect(gone.children!.map(d => d.label)).toEqual(['discarded: 2026-10-19']);
    expect(kept.label).toBe('DNA-2');
    expect(kept.dimmed).toBeUndefined();
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
      'waiting [1] (not an allowed status)',
      '(none) [1]',
    ]);
  });

  // #143
  it('marks a status outside the allowed list', () => {
    const odd = tree.children!.find(g => g.label.startsWith('waiting'))!;
    expect(odd.icon).toBe('warning');
    expect(odd.tooltip).toContain('planned, in-progress');
    expect(tree.children![0].icon).toBe('folder');
    expect(tree.children![0].tooltip).toBeUndefined();
  });

  it('sorts experiments by folder number and labels them with number and title', () => {
    const planned = tree.children![0].children!;
    expect(planned.map(e => e.label)).toEqual(['002 · GFP expression', '010 · Later run']);
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

  // #134
  it('marks an experiment flagged for discussion with its icon and tooltip', () => {
    const flagged = buildExperimentTree(
      [
        { folder: 'labnote/001_A', status: 'in-progress', discuss: true },
        { folder: 'labnote/002_B', status: 'in-progress' },
      ],
      { discuss: '논의 표시됨' }
    );
    const [a, b] = flagged.children![0].children!;
    expect(a).toMatchObject({ icon: 'comment-discussion', tooltip: 'labnote/001_A\nStatus: in-progress\n논의 표시됨' });
    expect(b).toMatchObject({ icon: 'file', tooltip: 'labnote/002_B\nStatus: in-progress' });
  });

  // #156, #157
  it('shows checklist progress and puts the title, status and last update in the tooltip', () => {
    const t = buildExperimentTree([
      {
        folder: 'labnote/067_나노자임_비색_센서',
        title: '나노자임 비색 센서',
        status: 'in-progress',
        lastUpdated: '2026-10-19',
        progress: { done: 1, total: 6 },
      },
      { folder: 'labnote/068_B', title: 'B', status: 'in-progress', progress: { done: 0, total: 0 } },
    ]);
    const [a, b] = t.children![0].children!;
    expect(a.label).toBe('067 · 나노자임 비색 센서 (1/6)');
    expect(a.tooltip).toBe(
      '나노자임 비색 센서\nlabnote/067_나노자임_비색_센서\nStatus: in-progress\nWorkflows done: 1/6\nLast updated: 2026-10-19'
    );
    expect(b.label).toBe('068 · B');
  });
});

// #204
describe('experiments by project', () => {
  const entries: ExperimentEntry[] = [
    { folder: 'labnote/074_B', title: 'CRISPR 2차', status: 'in-progress', project: 'CRISPR-다중편집' },
    { folder: 'labnote/052_A', title: 'CRISPR 1차', status: 'failed', project: ' CRISPR-다중편집 ' },
    { folder: 'labnote/010_C', title: 'GFP', status: 'completed', project: 'Biosensor' },
    { folder: 'labnote/003_D', title: 'Misc', status: 'planned' },
  ];

  it('groups one project together whatever the status, without a project last', () => {
    const t = buildExperimentTree(entries, { noProject: '(과제 없음)' }, 'project');
    expect(t.label).toBe('Experiments [4]');
    expect(t.children!.map(g => g.label)).toEqual(['Biosensor [1]', 'CRISPR-다중편집 [2]', '(과제 없음) [1]']);
    expect(t.children![1]).toMatchObject({ id: 'experimentProject:CRISPR-다중편집', kind: 'experimentProject' });
    expect(t.children![1].children!.map(e => e.label)).toEqual(['052 · CRISPR 1차', '074 · CRISPR 2차']);
  });

  it('names the project in the tooltip', () => {
    const t = buildExperimentTree(entries.slice(0, 1), { project: '과제' });
    expect(t.children![0].children![0].tooltip).toBe('CRISPR 2차\nlabnote/074_B\nStatus: in-progress\n과제: CRISPR-다중편집');
  });

  it('keeps grouping by status by default', () => {
    expect(buildExperimentTree(entries).children!.map(g => g.id)).toEqual([
      'experimentStatus:planned',
      'experimentStatus:in-progress',
      'experimentStatus:completed',
      'experimentStatus:failed',
    ]);
  });

  it('filters by folder, title, project or status, every word, any case', () => {
    expect(filterExperiments(entries, '  ')).toBe(entries);
    expect(filterExperiments(entries, 'crispr').map(e => e.folder)).toEqual(['labnote/074_B', 'labnote/052_A']);
    expect(filterExperiments(entries, 'crispr failed').map(e => e.folder)).toEqual(['labnote/052_A']);
    expect(filterExperiments(entries, '010').map(e => e.folder)).toEqual(['labnote/010_C']);
    expect(filterExperiments(entries, 'biosensor').map(e => e.folder)).toEqual(['labnote/010_C']);
    expect(filterExperiments(entries, 'nothing')).toEqual([]);
  });
});
