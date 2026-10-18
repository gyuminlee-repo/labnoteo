// Globals convention (no `import ... from 'vitest'`) — see sampleDefinition.test.ts.
import { insertUnitOperation } from '../commands/insertUnitOperation';
import { MemFileSystem } from '../fs/memFileSystem';
import type { EditTarget, LabnoteHost, NotifyKind } from '../host';

/** A workflow note as `createWorkflowContent` scaffolds it, minus front matter. */
const EMPTY_WORKFLOW = [
  '## [WD010 Design]',
  '',
  '> desc',
  '',
  '## Related Unit Operations',
  '',
  '> Unit operations are appended here automatically.',
  '',
  '## Conclusions and Discussion',
  '',
  '',
].join('\n');

/**
 * Minimal test host: records notifications and applies range edits to an
 * in-memory document, so assertions can check *where* the block landed.
 */
function makeHost(opts: {
  targetPath?: string;
  fs?: MemFileSystem;
  doc?: string;
  /** Cursor offset in the current document; without it the target has no cursor. */
  cursor?: (doc: string) => number;
}): {
  host: LabnoteHost;
  notes: Array<{ kind: NotifyKind; message: string }>;
  inserted: string[];
  doc: () => string;
} {
  const notes: Array<{ kind: NotifyKind; message: string }> = [];
  const inserted: string[] = [];
  let doc = opts.doc ?? '';

  const fs = opts.fs ?? new MemFileSystem();

  const target: EditTarget | undefined = opts.targetPath
    ? {
        path: opts.targetPath,
        async getText() {
          return doc;
        },
        async insertAtCursor() {
          throw new Error('unit operations must not be inserted at the cursor');
        },
        async replaceRange(start: number, end: number, text: string) {
          inserted.push(text);
          doc = doc.slice(0, start) + text + doc.slice(end);
        },
        ...(opts.cursor ? { getCursorOffset: async () => opts.cursor!(doc) } : {}),
      }
    : undefined;

  const host: LabnoteHost = {
    fs,
    async pick() {
      return undefined;
    },
    async pickMany() {
      return [];
    },
    async prompt() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    notify(kind, message) {
      notes.push({ kind, message });
    },
    editTarget() {
      return target;
    },
    async openFile() {
      /* noop */
    },
    t(key, ...args) {
      // Mirror vscode.l10n.t positional substitution so assertions can check
      // the interpolated message.
      return args.length
        ? key.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ''))
        : key;
    },
  };

  return { host, notes, inserted, doc: () => doc };
}

const VALID_WORKFLOW = '/vault/labnote/001_Exp/002_WD010_Design.labnote.md';

describe('insertUnitOperation', () => {
  it('inserts a HW template for a valid workflow path', async () => {
    const { host, inserted, notes } = makeHost({
      targetPath: VALID_WORKFLOW,
      doc: EMPTY_WORKFLOW,
    });

    const ok = await insertUnitOperation(host, {
      opId: 'UHW010',
      opName: 'Centrifugation',
      opDescription: 'spin down',
      opType: 'hw',
      equipment: 'Centrifuge 5424',
    });

    expect(ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain('### [UHW010 Centrifugation]');
    expect(inserted[0]).toContain('- Equipment: Centrifuge 5424');
    expect(notes.at(-1)).toEqual({
      kind: 'info',
      message: 'Unit operation inserted: UHW010 Centrifugation',
    });
  });

  it('places the block at the end of the unit-operations section', async () => {
    const { host, doc } = makeHost({ targetPath: VALID_WORKFLOW, doc: EMPTY_WORKFLOW });

    await insertUnitOperation(host, { opId: 'UHW010', opName: 'Spin', opType: 'hw' });

    const text = doc();
    expect(text.indexOf('### [UHW010 Spin]')).toBeGreaterThan(
      text.indexOf('## Related Unit Operations')
    );
    expect(text.indexOf('### [UHW010 Spin]')).toBeLessThan(
      text.indexOf('## Conclusions and Discussion')
    );
  });

  it('appends after the last block without a cursor', async () => {
    const { host, doc, notes } = makeHost({ targetPath: VALID_WORKFLOW, doc: EMPTY_WORKFLOW });

    await insertUnitOperation(host, { opId: 'UHW010', opName: 'First', opType: 'hw' });
    await insertUnitOperation(host, { opId: 'UHW020', opName: 'Second', opType: 'hw' });

    const text = doc();
    expect(text.indexOf('### [UHW010 First]')).toBeLessThan(text.indexOf('### [UHW020 Second]'));
    expect(text.indexOf('### [UHW020 Second]')).toBeLessThan(
      text.indexOf('## Conclusions and Discussion')
    );
    expect(notes.at(-1)?.message).toBe('Unit operation inserted: UHW020 Second (after the last unit operation)');
  });

  // #103: the block follows the cursor.
  describe('following the cursor', () => {
    const order = (text: string) => [...text.matchAll(/^### \[(\S+)/gm)].map(m => m[1]);
    async function twoBlocks(cursor: (doc: string) => number) {
      let pos: ((doc: string) => number) | undefined;
      const h = makeHost({ targetPath: VALID_WORKFLOW, doc: EMPTY_WORKFLOW, cursor: d => (pos ? pos(d) : d.length) });
      await insertUnitOperation(h.host, { opId: 'UHW010', opName: 'First', opType: 'hw' });
      await insertUnitOperation(h.host, { opId: 'UHW030', opName: 'Third', opType: 'hw' });
      pos = cursor;
      await insertUnitOperation(h.host, { opId: 'UHW020', opName: 'Second', opType: 'hw' });
      return h;
    }

    it('goes right after the block the cursor is in, between the separators', async () => {
      const { doc, notes } = await twoBlocks(d => d.indexOf('#### Method'));
      expect(order(doc())).toEqual(['UHW010', 'UHW020', 'UHW030']);
      expect(doc()).not.toMatch(/---\s*\n\s*---/);
      expect(doc().match(/^---$/gm)).toHaveLength(3);
      expect(notes.at(-1)?.message).toBe('Unit operation inserted: UHW020 Second (after [UHW010 First])');
    });

    it('goes before the first block when the cursor is in the TOC area', async () => {
      const { doc, notes } = await twoBlocks(d => d.indexOf('> Unit operations'));
      expect(order(doc())).toEqual(['UHW020', 'UHW010', 'UHW030']);
      expect(notes.at(-1)?.message).toBe('Unit operation inserted: UHW020 Second (before the first unit operation)');
    });

    it('goes after the last block when the cursor is outside the section', async () => {
      for (const at of [(d: string) => d.indexOf('## [WD010'), (d: string) => d.length]) {
        const { doc } = await twoBlocks(at);
        expect(order(doc())).toEqual(['UHW010', 'UHW030', 'UHW020']);
      }
    });

    it('goes after the last block when the cursor is in it', async () => {
      const { doc } = await twoBlocks(d => d.lastIndexOf('#### Output'));
      expect(order(doc())).toEqual(['UHW010', 'UHW030', 'UHW020']);
      expect(doc().indexOf('### [UHW020')).toBeLessThan(doc().indexOf('## Conclusions and Discussion'));
    });
  });

  it('falls back to the end of the document when the section is absent', async () => {
    const { host, doc } = makeHost({ targetPath: VALID_WORKFLOW, doc: '# Freeform note\n' });

    const ok = await insertUnitOperation(host, {
      opId: 'UHW010',
      opName: 'Spin',
      opType: 'hw',
    });

    expect(ok).toBe(true);
    expect(doc().indexOf('### [UHW010 Spin]')).toBeGreaterThan(doc().indexOf('# Freeform note'));
  });

  it('reads the experimenter from the sibling README front matter', async () => {
    const fs = new MemFileSystem();
    await fs.write(
      '/vault/labnote/001_Exp/README.labnote.md',
      '---\nauthor: Dr. Kim\n---\n# Notes\n'
    );
    const { host, inserted } = makeHost({
      targetPath: VALID_WORKFLOW,
      fs,
      doc: EMPTY_WORKFLOW,
    });

    await insertUnitOperation(host, {
      opId: 'USW010',
      opName: 'Alignment',
      opType: 'sw',
      software: 'BWA',
    });

    expect(inserted[0]).toContain('- Experimenter: Dr. Kim');
    expect(inserted[0]).toContain('- Software: BWA');
  });

  it('bails and warns when there is no active edit target', async () => {
    const { host, inserted, notes } = makeHost({});

    const ok = await insertUnitOperation(host, {
      opId: 'UHW010',
      opName: 'X',
      opType: 'hw',
    });

    expect(ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(notes.at(-1)?.kind).toBe('warn');
  });

  it('bails when the active document is not a valid workflow file', async () => {
    const { host, inserted, notes } = makeHost({
      targetPath: '/vault/labnote/001_Exp/README.labnote.md',
    });

    const ok = await insertUnitOperation(host, {
      opId: 'UHW010',
      opName: 'X',
      opType: 'hw',
    });

    expect(ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(notes.at(-1)?.kind).toBe('warn');
  });

  it('errors when required op info is missing', async () => {
    const { host, inserted, notes } = makeHost({ targetPath: VALID_WORKFLOW });

    const ok = await insertUnitOperation(host, {
      opId: '',
      opName: '',
      opType: 'hw',
    });

    expect(ok).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(notes.at(-1)?.kind).toBe('error');
  });
});
