/**
 * The Outline-drop tidy must rewrite the file only for the first `modify` after
 * a drop on the Outline pane, and never for other writes (editor saves, git
 * pulls, the save that follows an undo).
 */
import { describe, it, expect } from 'vitest';
import { findUnitOpInsertOffset, rebuildUnitOpToc, simulateOutlineHeadingMove } from '@labnoteo/core';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { buildHwUnitOpMarkdown } from '@labnoteo/core/lib/unitOpTemplate';
import { createOutlineDropTidy, OUTLINE_DROP_ARM_MS } from '../../src/outlineDropTidy';

const WORKFLOW_PATH = 'labnote/001_Exp/001_WD010_Design.labnote.md';

function buildNote(order: string[]): string {
  let md = createWorkflowContent({ id: 'WD010', name: 'Design', description: 'desc' }, 'Dr. Kim', undefined, {
    noteId: 'LN-00000000',
  });
  for (const opId of order) {
    const block = buildHwUnitOpMarkdown(
      { opId, opName: `Op ${opId}`, opDescription: 'step' },
      { experimenter: 'Dr. Kim', dateTime: '2026-09-29 10:00' }
    );
    const off = findUnitOpInsertOffset(md);
    md = rebuildUnitOpToc(md.slice(0, off) + block + md.slice(off));
  }
  return md;
}

/** Obsidian's Outline drop: move the `from` section before the `before` heading. */
function outlineDrag(v: string, from: string, before: string): string {
  const ensureBlank = (s: string) => (s.endsWith('\n\n') ? s : s.endsWith('\n') ? s + '\n' : s + '\n\n');
  const c = v.indexOf(from);
  const bodyStart = v.indexOf('\n', c) + 1;
  const u = bodyStart + v.slice(bodyStart).search(/^#{1,3} /m);
  const h = v.indexOf(before);
  const moved = ensureBlank(v.substring(c, u));
  return ensureBlank(v.substring(0, h)) + moved + v.substring(h, c) + v.substring(u);
}

function setup(opts: { enabled?: boolean } = {}) {
  let clock = 1000;
  const files = new Map<string, string>();
  const processed: string[] = [];
  const tidy = createOutlineDropTidy({
    isEnabled: () => opts.enabled ?? true,
    now: () => clock,
    process: async (path, fn) => {
      processed.push(path);
      files.set(path, fn(files.get(path) ?? ''));
    },
  });
  return { tidy, files, processed, advance: (ms: number) => (clock += ms) };
}

const dragged = () => outlineDrag(buildNote(['UHW010', 'UHW020', 'UHW030']), '### [UHW030', '### [UHW010');
const normBlank = (s: string) => s.replace(/\n{3,}/g, '\n\n');

/** Headings as Obsidian's metadata cache lists them (`{ level, start }`) plus the line text. */
function headingsOf(md: string) {
  const out: { level: number; start: number; text: string }[] = [];
  let offset = 0;
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{1,6})\s/);
    if (m) out.push({ level: m[1].length, start: offset, text: line });
    offset += line.length + 1;
  }
  return out;
}

/**
 * #22: Obsidian's real drop of UHW030 "after" UHW010, which lands on UHW010's
 * first `#### Meta`, plus the snapshot the plugin takes at drop time.
 */
function droppedOntoUnitOp() {
  const before = buildNote(['UHW010', 'UHW020', 'UHW030']);
  const headings = headingsOf(before);
  const movedIdx = headings.findIndex(h => h.text.startsWith('### [UHW030'));
  const target = headings.findIndex(h => h.text.startsWith('### [UHW010')) + 1;
  const to = headings.findIndex(h => h.text.startsWith('## Conclusions'));
  const after = simulateOutlineHeadingMove(before, headings[movedIdx].start, headings[to].start, headings[target].start);
  const correct = simulateOutlineHeadingMove(
    before,
    headings[movedIdx].start,
    headings[to].start,
    headings.find(h => h.text.startsWith('### [UHW020'))!.start
  );
  return { before, after, correct, snapshot: { before: Promise.resolve(before), headings, movedIdx } };
}

describe('createOutlineDropTidy', () => {
  it('tidies the TOC and separators on the first modify after a drop', async () => {
    const { tidy, files, processed } = setup();
    files.set(WORKFLOW_PATH, dragged());
    tidy.arm(WORKFLOW_PATH);
    await tidy.onModify(WORKFLOW_PATH);

    expect(processed).toEqual([WORKFLOW_PATH]);
    expect(normBlank(files.get(WORKFLOW_PATH)!)).toBe(normBlank(buildNote(['UHW030', 'UHW010', 'UHW020'])));
  });

  it('handles only one modify per drop', async () => {
    const { tidy, files, processed } = setup();
    files.set(WORKFLOW_PATH, dragged());
    tidy.arm(WORKFLOW_PATH);
    await tidy.onModify(WORKFLOW_PATH);
    await tidy.onModify(WORKFLOW_PATH);
    expect(processed).toHaveLength(1);
  });

  it('ignores modifies without a drop, after expiry, when disabled or for non-workflow notes', async () => {
    const plain = setup();
    await plain.tidy.onModify(WORKFLOW_PATH);
    expect(plain.processed).toEqual([]);

    const expired = setup();
    expired.tidy.arm(WORKFLOW_PATH);
    expired.advance(OUTLINE_DROP_ARM_MS + 1);
    await expired.tidy.onModify(WORKFLOW_PATH);
    expect(expired.processed).toEqual([]);

    const off = setup({ enabled: false });
    off.tidy.arm(WORKFLOW_PATH);
    await off.tidy.onModify(WORKFLOW_PATH);
    expect(off.processed).toEqual([]);

    const readme = setup();
    readme.tidy.arm('labnote/001_Exp/README.labnote.md');
    await readme.tidy.onModify('labnote/001_Exp/README.labnote.md');
    expect(readme.processed).toEqual([]);
  });

  it('leaves an already tidy note unchanged', async () => {
    const { tidy, files } = setup();
    const note = buildNote(['UHW010', 'UHW020']);
    files.set(WORKFLOW_PATH, note);
    tidy.arm(WORKFLOW_PATH);
    await tidy.onModify(WORKFLOW_PATH);
    expect(files.get(WORKFLOW_PATH)).toBe(note);
  });

  // #21-4: dragging a unit-op (H3) block in the Outline must carry its `####`
  // subsections (Meta/Input/Output/…) with it — none may be dropped or orphaned
  // onto the wrong block. The tidy only reorders the TOC and `---` separators,
  // so every subsection that existed before the drag must survive it, in the
  // same per-block sequence.
  it('preserves every `####` subsection of a dragged block (no sub-block loss)', async () => {
    const { tidy, files } = setup();
    files.set(WORKFLOW_PATH, dragged());
    tidy.arm(WORKFLOW_PATH);
    await tidy.onModify(WORKFLOW_PATH);

    const result = files.get(WORKFLOW_PATH)!;
    const subs = [...result.matchAll(/^#### (.+)$/gm)].map(m => m[1].trim());
    const perBlock = [
      'Meta', 'Input', 'Reagent', 'Labware and Consumables',
      'Equipment', 'Method', 'Output', 'Results & Discussions',
    ];
    // Three blocks, each with the full HW subsection sequence, in block order.
    expect(subs).toEqual([...perBlock, ...perBlock, ...perBlock]);

    // And the subsections stay grouped under their own `### [..]` heading: the
    // first `####` after each unit-op heading is always `Meta`.
    const headingThenSub = [...result.matchAll(/### \[(UHW\d+)[^\n]*\n[\s\S]*?\n#### (.+)/g)]
      .map(m => [m[1], m[2].trim()]);
    expect(headingThenSub).toEqual([
      ['UHW030', 'Meta'],
      ['UHW010', 'Meta'],
      ['UHW020', 'Meta'],
    ]);
  });

  it('moves a block dropped onto a unit op behind it, then tidies', async () => {
    const { tidy, files, processed } = setup();
    const drop = droppedOntoUnitOp();
    files.set(WORKFLOW_PATH, drop.after);
    tidy.arm(WORKFLOW_PATH, drop.snapshot);
    await tidy.onModify(WORKFLOW_PATH);

    expect(processed).toEqual([WORKFLOW_PATH]);
    expect(normBlank(files.get(WORKFLOW_PATH)!)).toBe(normBlank(buildNote(['UHW010', 'UHW030', 'UHW020'])));
  });

  it('repairs the drop even when the TOC sync is off, without tidying', async () => {
    const { tidy, files } = setup({ enabled: false });
    const drop = droppedOntoUnitOp();
    files.set(WORKFLOW_PATH, drop.after);
    tidy.arm(WORKFLOW_PATH, drop.snapshot);
    await tidy.onModify(WORKFLOW_PATH);
    expect(files.get(WORKFLOW_PATH)).toBe(drop.correct);
  });

  it('only tidies when the snapshot cannot explain the new text', async () => {
    const drop = droppedOntoUnitOp();
    const plain = setup();
    plain.files.set(WORKFLOW_PATH, drop.after);
    plain.tidy.arm(WORKFLOW_PATH);
    await plain.tidy.onModify(WORKFLOW_PATH);

    const reads = [() => Promise.resolve('unrelated'), () => Promise.reject(new Error('read failed'))];
    for (const read of reads) {
      const { tidy, files } = setup();
      files.set(WORKFLOW_PATH, drop.after);
      tidy.arm(WORKFLOW_PATH, { ...drop.snapshot, before: read() });
      await tidy.onModify(WORKFLOW_PATH);
      expect(files.get(WORKFLOW_PATH)).toBe(plain.files.get(WORKFLOW_PATH));
    }
  });
});
