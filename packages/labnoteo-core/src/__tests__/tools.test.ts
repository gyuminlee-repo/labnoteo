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
        data: { documentPath: NOTE_PATH, heading: 'Method', parentHeading: '[UHW100 PCR] 첫 증폭', occurrence: 1, total: 1 },
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
