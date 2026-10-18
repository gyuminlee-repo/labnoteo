// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { MemFileSystem } from '../fs/memFileSystem';
import { createLabnoteTools, runTool, type ToolContext } from '../tools';

const README = [
  '---',
  'title: 001 Test',
  'author: Dr. Kim',
  'created_date: 2026-01-01',
  '---',
  '',
  '## Related Workflows',
  '',
  '> Workflows are listed here.',
  '',
].join('\n');

const NOTE_DIR = 'labnote/001_Test';
const NOTE_PATH = `${NOTE_DIR}/001_WD010_Design.labnote.md`;

let fs: MemFileSystem;
let ctx: ToolContext;

beforeEach(async () => {
  fs = new MemFileSystem();
  await fs.write(`${NOTE_DIR}/README.labnote.md`, README);
  await fs.write(NOTE_PATH, '## [WD010 Design]\n');
  ctx = { fs, workspaceRoot: '.', globalSampleFolder: 'resources/labsamples' };
});

function tool(name: string) {
  const t = createLabnoteTools().find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

describe('labnote tools — registry', () => {
  it('exposes the documented tools with input schemas', () => {
    const names = createLabnoteTools().map(t => t.name).sort();
    expect(names).toEqual(
      [
        'create_sample',
        'create_workflow',
        'get_sample',
        'get_unit_operation',
        'list_samples',
        'update_section',
      ].sort()
    );
    for (const t of createLabnoteTools()) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  it('runTool reports unknown tools', async () => {
    const res = await runTool(createLabnoteTools(), 'nope', ctx, {});
    expect(res.ok).toBe(false);
  });
});

describe('create_sample / get_sample / list_samples', () => {
  it('creates then reads back a sample by id', async () => {
    const created = await tool('create_sample').handler(ctx, {
      type: 'DNA',
      id: 'DNA-1',
      alias: 'plasmidA',
      description: 'first',
      documentPath: NOTE_PATH,
    });
    expect(created.ok).toBe(true);
    expect((created.data as { id: string }).id).toBe('DNA-1');

    const got = await tool('get_sample').handler(ctx, {
      type: 'DNA',
      id: 'DNA-1',
      documentPath: NOTE_PATH,
    });
    expect(got.ok).toBe(true);
    expect(got.data).toMatchObject({ id: 'DNA-1', alias: 'plasmidA' });
  });

  it('auto-generates an id when none is given', async () => {
    const res = await tool('create_sample').handler(ctx, {
      type: 'RNA',
      documentPath: NOTE_PATH,
    });
    expect(res.ok).toBe(true);
    expect((res.data as { id: string }).id).toMatch(/^RNA-/);
  });

  it('rejects an alias with ";" or ":" and a description with ";" without writing (#98)', async () => {
    for (const args of [{ alias: 'EXT-01;여름' }, { alias: '1:10' }, { description: '여름; 추출' }]) {
      const res = await tool('create_sample').handler(ctx, {
        type: 'DNA',
        id: 'DNA-7',
        documentPath: NOTE_PATH,
        ...args,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/retry/);
    }
    const listed = await tool('list_samples').handler(ctx, { type: 'DNA', documentPath: NOTE_PATH });
    expect(listed.data).toEqual([]);
    const ok = await tool('create_sample').handler(ctx, {
      type: 'DNA',
      id: 'DNA-7',
      alias: '1-10',
      description: '여름: 추출',
      documentPath: NOTE_PATH,
    });
    expect(ok.ok).toBe(true);
  });

  it('lists samples of a type', async () => {
    await tool('create_sample').handler(ctx, { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH });
    await tool('create_sample').handler(ctx, { type: 'DNA', id: 'DNA-2', documentPath: NOTE_PATH });
    const res = await tool('list_samples').handler(ctx, { type: 'DNA', documentPath: NOTE_PATH });
    expect(res.ok).toBe(true);
    expect((res.data as Array<{ id: string }>).map(s => s.id).sort()).toEqual(['DNA-1', 'DNA-2']);
  });

  it('get_sample fails for a missing sample', async () => {
    const res = await tool('get_sample').handler(ctx, {
      type: 'DNA',
      id: 'DNA-999',
      documentPath: NOTE_PATH,
    });
    expect(res.ok).toBe(false);
  });

  it('stores a storage location and lists it', async () => {
    const location = '-80 냉동고 2 / Box-3 / A3';
    await tool('create_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', location, documentPath: NOTE_PATH });

    const got = await tool('get_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', documentPath: NOTE_PATH });
    expect(got.data).toMatchObject({ location });
    const listed = await tool('list_samples').handler(ctx, { type: 'RNA', documentPath: NOTE_PATH });
    expect(listed.data).toEqual([{ id: 'RNA-1', alias: null, description: null, location }]);
  });

  it('keeps an existing location when a later call omits it or leaves it empty', async () => {
    const location = 'Freezer-2 / Box-3 / A1';
    await tool('create_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', location, documentPath: NOTE_PATH });
    await tool('create_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', alias: 'R1', documentPath: NOTE_PATH });
    await tool('create_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', location: '', documentPath: NOTE_PATH });

    const got = await tool('get_sample').handler(ctx, { type: 'RNA', id: 'RNA-1', documentPath: NOTE_PATH });
    expect(got.data).toMatchObject({ location });
  });

  // #73: a second call used to replace the descriptions and sources and drop the alias.
  it('adds to an existing sample instead of replacing it', async () => {
    const other = `${NOTE_DIR}/002_WB030_Other.labnote.md`;
    await fs.write(other, '## [WB030 Other]\n');
    await tool('create_sample').handler(ctx, {
      type: 'Equip',
      id: 'Equip-1',
      alias: 'NanoDrop',
      description: 'first',
      documentPath: NOTE_PATH,
    });
    await tool('create_sample').handler(ctx, {
      type: 'Equip',
      id: 'Equip-1',
      description: 'second',
      documentPath: other,
    });
    await tool('create_sample').handler(ctx, {
      type: 'Equip',
      id: 'Equip-1',
      description: 'first',
      documentPath: other,
    });

    const records = JSON.parse(await fs.read(`${NOTE_DIR}/resources/labsamples/Equip.json`));
    expect(records['Equip-1']).toEqual({
      type: 'Equip',
      alias: 'NanoDrop',
      descriptions: ['first', 'second'],
      sources: ['001_WD010_Design.labnote.md', '002_WB030_Other.labnote.md'],
      location: null,
    });
  });

  // #58: a mistyped experiment path used to create a stray folder.
  it('refuses a note that does not exist and writes nothing', async () => {
    const before = fs.snapshot();
    const res = await tool('create_sample').handler(ctx, {
      type: 'Primer',
      alias: 'typo',
      documentPath: 'labnote/031_GFP_발현_비교/README.labnote.md',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Note not found: labnote/031_GFP_발현_비교/README.labnote.md');
    expect(fs.snapshot()).toEqual(before);
    expect(await fs.exists('labnote/031_GFP_발현_비교')).toBe(false);
  });

  it('refuses a folder path, which would store samples in its parent', async () => {
    const before = fs.snapshot();
    const res = await tool('create_sample').handler(ctx, { type: 'DNA', documentPath: NOTE_DIR });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Note not found');
    expect(fs.snapshot()).toEqual(before);
  });

  it('says a path outside the vault is outside, not missing', async () => {
    const res = await tool('create_sample').handler(ctx, {
      type: 'DNA',
      documentPath: '../../../ESCAPED/README.labnote.md',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('documentPath is outside the vault: ../../../ESCAPED/README.labnote.md');

    const missing = await tool('create_sample').handler(ctx, { type: 'DNA' });
    expect(missing.error).toBe('type and documentPath are required');
  });

  // #61: ids that break `<Type>-<number>` were stored as given.
  it('rejects an id that is not <type>-<number> and writes nothing', async () => {
    const before = fs.snapshot();
    const res = await tool('create_sample').handler(ctx, { type: 'Equip', id: 'ND-11', documentPath: NOTE_PATH });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Invalid id "ND-11": expected Equip-<number>. Omit id to generate one.');
    expect(fs.snapshot()).toEqual(before);
  });

  it('spells a known type and its id prefix canonically', async () => {
    const res = await tool('create_sample').handler(ctx, { type: 'equip', id: 'equip-3', documentPath: NOTE_PATH });
    expect(res.data).toMatchObject({ id: 'Equip-3', type: 'Equip' });
    expect(await fs.exists(`${NOTE_DIR}/resources/labsamples/Equip.json`)).toBe(true);
  });

  it('canonicalises custom types from the context and still accepts unknown ones', async () => {
    const custom = { ...ctx, customTypes: ['배지'] };
    const known = await tool('create_sample').handler(custom, { type: '배지', id: '배지-2', documentPath: NOTE_PATH });
    expect(known.data).toMatchObject({ id: '배지-2', type: '배지' });
    const unknown = await tool('create_sample').handler(ctx, { type: 'Gizmo', documentPath: NOTE_PATH });
    expect(unknown.ok).toBe(true);
    expect((unknown.data as { id: string }).id).toMatch(/^Gizmo-\d/);
  });

  // #64: a vault-root note's local folder is the global one.
  it('reports the folder and scope it wrote to', async () => {
    const local = await tool('create_sample').handler(ctx, { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH });
    expect(local.data).toMatchObject({ folder: `${NOTE_DIR}/resources/labsamples`, scope: 'local' });
    expect(local.warnings).toBeUndefined();

    await fs.write('Welcome.md', '# Hi\n');
    const root = await tool('create_sample').handler(ctx, { type: 'DNA', id: 'DNA-2', documentPath: 'Welcome.md' });
    expect(root.data).toMatchObject({ folder: 'resources/labsamples', scope: 'global' });
    expect(root.warnings?.[0]).toContain('outside an experiment folder');
  });

  // #113
  describe('describe', () => {
    it('previews the sample it would write, without writing', async () => {
      const describe = tool('create_sample').describe!;
      expect(
        await describe(ctx, { type: 'reagent', alias: '배지성분-1', location: '선반-M', documentPath: NOTE_PATH })
      ).toEqual({
        kind: 'sampleCreate',
        type: 'Reagent',
        id: undefined,
        existing: false,
        alias: '배지성분-1',
        location: '선반-M',
        folder: `${NOTE_DIR}/resources/labsamples`,
        scope: 'local',
      });
      expect(await fs.exists(`${NOTE_DIR}/resources/labsamples/Reagent.json`)).toBe(false);
    });

    it('says when the id is already recorded', async () => {
      await tool('create_sample').handler(ctx, { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH });
      const describe = tool('create_sample').describe!;
      expect(await describe(ctx, { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH })).toMatchObject({
        id: 'DNA-1',
        existing: true,
      });
      expect(await describe(ctx, { type: 'DNA', id: 'DNA-2', documentPath: NOTE_PATH })).toMatchObject({
        id: 'DNA-2',
        existing: false,
      });
    });

    it('returns the error the call would fail with', async () => {
      const describe = tool('create_sample').describe!;
      expect(await describe(ctx, { type: 'DNA', id: 'ND-11', documentPath: NOTE_PATH })).toEqual({
        error: 'Invalid id "ND-11": expected DNA-<number>. Omit id to generate one.',
      });
      expect(await describe(ctx, { type: 'DNA', documentPath: `${NOTE_DIR}/missing.md` })).toHaveProperty('error');
    });
  });
});

describe('runTool — unsupported arguments', () => {
  it('runs the tool and warns about arguments it ignored', async () => {
    const res = await runTool(createLabnoteTools(), 'create_sample', ctx, {
      type: 'RNA',
      id: 'RNA-1',
      freezer: 'F2',
      documentPath: NOTE_PATH,
    });
    expect(res.ok).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0]).toContain('freezer');
    expect(res.warnings![0]).toContain('Supported: type, id, alias, description, location, documentPath');
  });

  it('adds no warnings when every argument is declared', async () => {
    const res = await runTool(createLabnoteTools(), 'create_sample', ctx, {
      type: 'RNA',
      documentPath: NOTE_PATH,
    });
    expect(res.warnings).toBeUndefined();
  });

  it('warns on a failed call too', async () => {
    const res = await runTool(createLabnoteTools(), 'get_sample', ctx, { type: 'DNA', id: 'DNA-999', foo: 1 });
    expect(res.ok).toBe(false);
    expect(res.warnings![0]).toContain('foo');
  });

  it('does not treat an array argument as named arguments', async () => {
    const res = await runTool(
      createLabnoteTools(),
      'list_samples',
      ctx,
      ['DNA'] as unknown as Record<string, unknown>
    );
    expect(res.warnings).toBeUndefined();
  });
});

describe('get_unit_operation', () => {
  it('returns catalog info for a known unit op', async () => {
    // Ensure the catalog is materialised, then pick a real op id.
    const { loadUnitOperations, ensureWorkflowResources } = await import(
      '../lib/workflowDataLoader'
    );
    await ensureWorkflowResources(fs, '.');
    const hw = await loadUnitOperations(fs, '.', 'hw');
    const sample = hw.unitOperations[0];
    expect(sample).toBeDefined();

    const res = await tool('get_unit_operation').handler(ctx, { opId: sample.id });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ id: sample.id, opType: 'hw' });
  });

  it('fails for an unknown op id', async () => {
    const res = await tool('get_unit_operation').handler(ctx, { opId: 'ZZZ999' });
    expect(res.ok).toBe(false);
  });
});

describe('update_section', () => {
  it('replaces a section body non-lossily', async () => {
    const doc = ['## [WD010 Design]', '', '#### Method', '', 'old', '', '#### Results', '', 'r', ''].join(
      '\n'
    );
    await fs.write(NOTE_PATH, doc);
    const res = await tool('update_section').handler(ctx, {
      documentPath: NOTE_PATH,
      heading: 'Method',
      content: 'NEW method',
    });
    expect(res.ok).toBe(true);
    const after = await fs.read(NOTE_PATH);
    expect(after).toContain('NEW method');
    expect(after).not.toContain('old');
    expect(after).toContain('#### Results');
  });

  it('says a path outside the vault is outside', async () => {
    const res = await tool('update_section').handler(ctx, {
      documentPath: '../x.md',
      heading: 'Method',
      content: 'x',
    });
    expect(res.error).toBe('documentPath is outside the vault: ../x.md');
  });

  it('fails when the section is absent', async () => {
    await fs.write(NOTE_PATH, '## Only\n\nx\n');
    const res = await tool('update_section').handler(ctx, {
      documentPath: NOTE_PATH,
      heading: 'Missing',
      content: 'x',
    });
    expect(res.ok).toBe(false);
  });

  // #51: unit operations repeat the same sub-headings.
  describe('with repeated unit operations', () => {
    const doc = [
      '## 🔬 Unit Operations',
      '',
      '### [USW230 Sequence Embedding]',
      '',
      '#### Method',
      '',
      'embed-1',
      '',
      '### [UHW100 PCR] 첫 증폭',
      '',
      '#### Method',
      '',
      'pcr',
      '',
      '### [USW230 Sequence Embedding] 재실행',
      '',
      '#### Method',
      '',
      'embed-2',
      '',
    ].join('\n');
    const run = (extra: Record<string, unknown>) =>
      tool('update_section').handler(ctx, { documentPath: NOTE_PATH, heading: 'Method', content: 'NEW', ...extra });

    it('refuses to guess and lists the candidates', async () => {
      await fs.write(NOTE_PATH, doc);
      const res = await run({});
      expect(res.ok).toBe(false);
      expect(res.error).toContain('matches 3 sections');
      expect(res.error).toContain('occurrence 2 under "[UHW100 PCR] 첫 증폭" (line 11)');
      expect(await fs.read(NOTE_PATH)).toBe(doc);
    });

    it('targets the section under a unit operation given by id or full heading', async () => {
      await fs.write(NOTE_PATH, doc);
      const res = await run({ parentHeading: 'UHW100' });
      expect(res).toEqual({
        ok: true,
        data: {
          documentPath: NOTE_PATH,
          heading: 'Method',
          parentHeading: '[UHW100 PCR] 첫 증폭',
          occurrence: 1,
          total: 1,
          removedLines: 1,
          removedSubheadings: 0,
          previousBody: 'pcr',
        },
      });
      const after = await fs.read(NOTE_PATH);
      expect(after).toContain('embed-1');
      expect(after).not.toContain('pcr\n');
      expect(after).toContain('embed-2');

      await fs.write(NOTE_PATH, doc);
      expect((await run({ parentHeading: '[UHW100 PCR] 첫 증폭' })).ok).toBe(true);
      await fs.write(NOTE_PATH, doc);
      expect((await run({ parentHeading: 'UHW100 PCR' })).ok).toBe(true);
    });

    it('needs occurrence when the same unit operation appears twice', async () => {
      await fs.write(NOTE_PATH, doc);
      const ambiguous = await run({ parentHeading: 'USW230' });
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.error).toContain('Call again with occurrence');

      const res = await run({ parentHeading: 'USW230', occurrence: 2 });
      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({ parentHeading: '[USW230 Sequence Embedding] 재실행', occurrence: 2, total: 2 });
      const after = await fs.read(NOTE_PATH);
      expect(after).toContain('embed-1');
      expect(after).not.toContain('embed-2');
    });

    it('takes occurrence alone and rejects out-of-range or bad values', async () => {
      await fs.write(NOTE_PATH, doc);
      expect((await run({ occurrence: 3 })).ok).toBe(true);
      expect(await fs.read(NOTE_PATH)).not.toContain('embed-2');

      await fs.write(NOTE_PATH, doc);
      expect((await run({ occurrence: 4 })).error).toContain('out of range');
      expect((await run({ occurrence: 0 })).error).toContain('positive integer');
      expect((await run({ parentHeading: 'UXX999' })).error).toContain('No "Method" section under "UXX999"');
      expect(await fs.read(NOTE_PATH)).toBe(doc);
    });
  });

  // #69: `content: ""` (meant as "no change") wiped a Results section and its subsections.
  describe('empty content', () => {
    const doc = [
      '## [WD010 Design]',
      '',
      '#### Results',
      '',
      'OD600 0.82',
      '',
      '##### Gel',
      '',
      'band at 1 kb',
      '',
      '#### Notes',
      '',
      'n',
      '',
    ].join('\n');
    const call = (extra: Record<string, unknown>) =>
      tool('update_section').handler(ctx, { documentPath: NOTE_PATH, heading: 'Results', ...extra });

    it('is refused without clear: true and writes nothing', async () => {
      await fs.write(NOTE_PATH, doc);
      for (const content of ['', '  \n ']) {
        const res = await call({ content });
        expect(res.ok).toBe(false);
        expect(res.error).toContain('clear: true');
      }
      expect(await fs.read(NOTE_PATH)).toBe(doc);
    });

    it('empties the section with clear: true and reports what went', async () => {
      await fs.write(NOTE_PATH, doc);
      const res = await call({ content: '', clear: true });
      expect(res.data).toMatchObject({
        removedLines: 3,
        removedSubheadings: 1,
        previousBody: 'OD600 0.82\n\n##### Gel\n\nband at 1 kb',
      });
      const after = await fs.read(NOTE_PATH);
      expect(after).not.toContain('OD600');
      expect(after).toContain('#### Notes\n\nn');
    });

    it('rejects clear: true together with content', async () => {
      await fs.write(NOTE_PATH, doc);
      expect((await call({ content: 'x', clear: true })).error).toContain('content must be ""');
      expect(await fs.read(NOTE_PATH)).toBe(doc);
    });

    it('caps previousBody', async () => {
      await fs.write(NOTE_PATH, `#### Results\n\n${'a'.repeat(800)}\n`);
      const res = await call({ content: 'new' });
      expect((res.data as { previousBody: string }).previousBody).toHaveLength(500);
    });
  });

  describe('describe', () => {
    const doc = '## [WD010 Design]\n\n#### Results\n\nr1\nr2\n\n#### Notes\n\nn\n';

    it('previews the section and how much it holds, without writing', async () => {
      await fs.write(NOTE_PATH, doc);
      const describe = tool('update_section').describe!;
      expect(await describe(ctx, { documentPath: NOTE_PATH, heading: 'Results', content: 'x' })).toEqual({
        kind: 'sectionEdit',
        documentPath: NOTE_PATH,
        heading: 'Results',
        parentHeading: '[WD010 Design]',
        occurrence: 1,
        total: 1,
        line: 3,
        removedLines: 2,
        removedSubheadings: 0,
        clearing: false,
      });
      expect(
        await describe(ctx, { documentPath: NOTE_PATH, heading: 'Results', content: '', clear: true })
      ).toMatchObject({ clearing: true });
      expect(await fs.read(NOTE_PATH)).toBe(doc);
    });

    // #114
    it('says which of the repeated sections it is, and on which line', async () => {
      await fs.write(
        NOTE_PATH,
        '### [UHW015 Dispense]\n\n#### Method\n\na\n\n### [UHW015 Dispense]\n\n#### Method\n\nb\n'
      );
      const describe = tool('update_section').describe!;
      expect(
        await describe(ctx, { documentPath: NOTE_PATH, heading: 'Method', occurrence: 2, content: 'x' })
      ).toMatchObject({ parentHeading: '[UHW015 Dispense]', occurrence: 2, total: 2, line: 9 });
    });

    it('returns the error the call would fail with', async () => {
      await fs.write(NOTE_PATH, doc);
      const describe = tool('update_section').describe!;
      expect(await describe(ctx, { documentPath: NOTE_PATH, heading: 'Missing', content: 'x' })).toEqual({
        error: 'Section not found: Missing',
      });
      expect(await describe(ctx, { documentPath: NOTE_PATH, heading: 'Results', content: '' })).toHaveProperty(
        'error'
      );
    });
  });
});

describe('create_workflow', () => {
  it('creates a workflow file and registers it in the README', async () => {
    const { loadWorkflows, ensureWorkflowResources } = await import('../lib/workflowDataLoader');
    await ensureWorkflowResources(fs, '.');
    const catalog = await loadWorkflows(fs, '.');
    const wf = catalog.workflows[0];

    const res = await tool('create_workflow').handler(ctx, {
      documentPath: `${NOTE_DIR}/README.labnote.md`,
      workflowId: wf.id,
    });
    expect(res.ok).toBe(true);
    const { path } = res.data as { path: string };
    expect(await fs.exists(path)).toBe(true);

    const readme = await fs.read(`${NOTE_DIR}/README.labnote.md`);
    expect(readme).toContain(wf.id);
    expect(await fs.read(path)).not.toContain('유닛 오퍼레이션 삽입');
  });

  // #38: notes an agent scaffolds follow the host UI language like the commands.
  it('names the Korean palette command when the host locale is Korean', async () => {
    const { loadWorkflows, ensureWorkflowResources } = await import('../lib/workflowDataLoader');
    await ensureWorkflowResources(fs, '.');
    const wf = (await loadWorkflows(fs, '.')).workflows[0];

    const res = await tool('create_workflow').handler(
      { ...ctx, locale: 'ko' },
      { documentPath: `${NOTE_DIR}/README.labnote.md`, workflowId: wf.id }
    );
    expect(res.ok).toBe(true);
    const { path } = res.data as { path: string };
    expect(await fs.read(path)).toContain('(`유닛 오퍼레이션 삽입`)');
  });

  it('fails for an unknown workflow id', async () => {
    const res = await tool('create_workflow').handler(ctx, {
      documentPath: `${NOTE_DIR}/README.labnote.md`,
      workflowId: 'NOPE999',
    });
    expect(res.ok).toBe(false);
  });

  // #58: same stray-folder problem as create_sample.
  it('refuses an experiment folder without a README and writes nothing', async () => {
    const { loadWorkflows, ensureWorkflowResources } = await import('../lib/workflowDataLoader');
    await ensureWorkflowResources(fs, '.');
    const wf = (await loadWorkflows(fs, '.')).workflows[0];
    const before = fs.snapshot();

    const res = await tool('create_workflow').handler(ctx, {
      documentPath: 'labnote/031_없는실험/README.labnote.md',
      workflowId: wf.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Experiment not found: labnote/031_없는실험');
    expect(fs.snapshot()).toEqual(before);
  });

  it('says a path outside the vault is outside', async () => {
    const res = await tool('create_workflow').handler(ctx, {
      documentPath: '../outside/labnote/001_X/README.labnote.md',
      workflowId: 'WD010',
    });
    expect(res.error).toContain('documentPath is outside the vault');
  });

  // #124: the approval prompt has to tell two calls on one experiment apart.
  describe('describe', () => {
    const describe = (c: ToolContext, a: Record<string, unknown>) => tool('create_workflow').describe!(c, a);

    it('names the workflow, the file it creates and the README, writing nothing', async () => {
      const before = fs.snapshot();
      const preview = await describe(ctx, { documentPath: `${NOTE_DIR}/README.labnote.md`, workflowId: 'WT110' });
      expect(preview).toMatchObject({
        kind: 'workflowCreate',
        workflowId: 'WT110',
        fileName: expect.stringMatching(/^002_WT110_.+\.labnote\.md$/),
        readmePath: `${NOTE_DIR}/README.labnote.md`,
      });
      // The catalog files are not there yet: the bundled catalog answers, and
      // seeding them is left to the handler, after the user allows it.
      expect(fs.snapshot()).toEqual(before);

      const res = await tool('create_workflow').handler(ctx, {
        documentPath: `${NOTE_DIR}/README.labnote.md`,
        workflowId: 'WT110',
      });
      expect((res.data as { fileName: string }).fileName).toBe((preview as { fileName: string }).fileName);
    });

    it('rejects the calls the handler would reject', async () => {
      expect(await describe(ctx, { documentPath: `${NOTE_DIR}/README.labnote.md`, workflowId: 'NOPE999' })).toEqual({
        error: 'Workflow not found: NOPE999',
      });
      expect(
        await describe(ctx, { documentPath: 'labnote/031_없는실험/README.labnote.md', workflowId: 'WT110' })
      ).toHaveProperty('error');
    });
  });
});

// `mutates` drives the host's "allow this write?" prompt, so a tool marked
// read-only that quietly writes would bypass user consent entirely. Rather than
// restate the flags (a change-detector test that proves nothing), run each
// read-only tool and assert the vault is byte-identical afterwards.
describe('ToolDef.mutates', () => {
  it('every tool declares whether it mutates', () => {
    for (const t of createLabnoteTools()) {
      expect(typeof t.mutates, `${t.name}.mutates`).toBe('boolean');
    }
  });

  /** Plausible args per tool, so handlers get far enough to write if they would. */
  const argsFor: Record<string, Record<string, unknown>> = {
    get_sample: { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH },
    list_samples: { type: 'DNA', documentPath: NOTE_PATH },
    get_unit_operation: { opId: 'UHW010' },
  };

  it('read-only tools leave the vault untouched', async () => {
    const { ensureWorkflowResources } = await import('../lib/workflowDataLoader');
    // Seed the catalog first: lazily creating it is allowed (invisible to the
    // user), and we want to catch writes beyond that.
    await ensureWorkflowResources(fs, '.');
    await runTool(createLabnoteTools(), 'create_sample', ctx, {
      type: 'DNA',
      id: 'DNA-1',
      documentPath: NOTE_PATH,
    });

    for (const t of createLabnoteTools().filter(x => !x.mutates)) {
      const before = fs.snapshot();
      await t.handler(ctx, argsFor[t.name] ?? {});
      expect(fs.snapshot(), `${t.name} wrote to the vault but is marked read-only`).toEqual(before);
    }
  });

  it('mutating tools actually change the vault', async () => {
    const before = fs.snapshot();
    const res = await runTool(createLabnoteTools(), 'create_sample', ctx, {
      type: 'DNA',
      id: 'DNA-1',
      documentPath: NOTE_PATH,
    });
    expect(res.ok).toBe(true);
    expect(fs.snapshot()).not.toEqual(before);
  });
});

// A note the AI edits may be open in the host's editor, whose buffer would
// overwrite a raw filesystem write on its next flush. Hosts that have an
// editor-aware write path supply it as `ctx.writeNote`.
describe('ctx.writeNote hook', () => {
  /** Records calls and applies them, so later reads see the change. */
  const spyHook = (target: MemFileSystem) => {
    const calls: Array<{ path: string; content: string }> = [];
    return {
      calls,
      writeNote: async (path: string, content: string) => {
        calls.push({ path, content });
        await target.write(path, content);
      },
    };
  };

  it('update_section writes through the hook instead of fs', async () => {
    const hook = spyHook(fs);
    await fs.write(NOTE_PATH, '## [WD010 Design]\n\n#### Method\n\nold\n');

    const res = await tool('update_section').handler(
      { ...ctx, writeNote: hook.writeNote },
      { documentPath: NOTE_PATH, heading: 'Method', content: 'NEW' }
    );

    expect(res.ok).toBe(true);
    expect(hook.calls.map(c => c.path)).toEqual([NOTE_PATH]);
    expect(await fs.read(NOTE_PATH)).toContain('NEW');
  });

  it('create_workflow routes both the new file and the README through the hook', async () => {
    const { loadWorkflows, ensureWorkflowResources } = await import('../lib/workflowDataLoader');
    await ensureWorkflowResources(fs, '.');
    const wf = (await loadWorkflows(fs, '.')).workflows[0];
    const readmePath = `${NOTE_DIR}/README.labnote.md`;
    const hook = spyHook(fs);

    const res = await tool('create_workflow').handler(
      { ...ctx, writeNote: hook.writeNote },
      { documentPath: readmePath, workflowId: wf.id }
    );

    expect(res.ok).toBe(true);
    const { path } = res.data as { path: string };
    expect(hook.calls.map(c => c.path)).toEqual([path, readmePath]);
  });

  it('falls back to fs.write when no hook is supplied', async () => {
    await fs.write(NOTE_PATH, '## [WD010 Design]\n\n#### Method\n\nold\n');
    const res = await tool('update_section').handler(ctx, {
      documentPath: NOTE_PATH,
      heading: 'Method',
      content: 'NEW',
    });
    expect(res.ok).toBe(true);
    expect(await fs.read(NOTE_PATH)).toContain('NEW');
  });

  it('is not used for sample data files, which are not notes', async () => {
    const hook = spyHook(fs);
    const res = await tool('create_sample').handler(
      { ...ctx, writeNote: hook.writeNote },
      { type: 'DNA', id: 'DNA-1', documentPath: NOTE_PATH }
    );
    expect(res.ok).toBe(true);
    expect(hook.calls).toEqual([]);
  });
});
