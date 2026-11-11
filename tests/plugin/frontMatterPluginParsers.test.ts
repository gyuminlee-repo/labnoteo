/**
 * Plugin readers of a note's headings leave its front matter out: a `### [ID …]` YAML comment
 * there is no unit operation, for the model's note context or the catalog's count of notes.
 */
import { describe, it, expect } from 'vitest';
import type { LabnoteHost } from '@labnoteo/core';
import { MemFileSystem } from '../../packages/labnoteo-core/src/fs/memFileSystem';
import { unitOpContext } from '../../src/llm/commands';
import { notesUsing } from '../../src/catalogUpdate';

describe('readers of a note whose front matter has a unit-operation-like comment', () => {
  it('give the model the note head down to the first body unit operation', () => {
    const text = '---\n### [UHW999 Example]\ntitle: Important\n---\n## [WD010 Real]\ndescription\n### [UHW010 Spin]\n#### Method\nactual';
    const context = unitOpContext(text, { unitOpStartLine: 6, unitOpEndLine: 9 } as never);
    expect(context).toContain('## [WD010 Real]\ndescription');
    expect(context.split('\n\nUnit operation:\n')[1]).toBe('### [UHW010 Spin]\n#### Method\nactual');
  });

  it('count no note for a unit operation named in its front matter only', async () => {
    const fs = new MemFileSystem({ 'labnote/001_A/001_WD010_A.labnote.md': '---\n### [UHW999 Example]\ntag: x\n---\n## [WD010 Real]\n' });
    expect(await notesUsing({ fs } as unknown as LabnoteHost, new Set(['UHW999']))).toBe(0);
  });
});
