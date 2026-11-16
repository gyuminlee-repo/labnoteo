import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notice } from '../stubs/obsidian';
import { guardScanAction } from '../../src/scan/actionGuard';

const SCAN = join(__dirname, '..', '..', 'src', 'scan');

describe('a scan action no one awaits', () => {
  it('says its failure in a notice, and does not reject', async () => {
    const before = Notice.shown.length;
    await expect(guardScanAction((key, ...args) => key.replace('{0}', String(args[0])), async () => Promise.reject(new Error('QA_READ_FAIL note.md')))).resolves.toBeUndefined();
    expect(Notice.shown.slice(before)).toEqual(['Command failed: QA_READ_FAIL note.md']);
  });

  // A button or drop handler of a scan modal starts its work through guardScanAction: an
  // `async` handler or a bare `void` call there ends a read failure as an unhandled rejection.
  it('is how every scan modal starts its button and drop work', () => {
    const found: string[] = [];
    for (const name of readdirSync(SCAN).filter(n => /Modal\.ts$/.test(n))) {
      readFileSync(join(SCAN, name), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\.onClick\(\s*async\b|addEventListener\([^,]+,\s*async\b|\bvoid (?!guardScanAction\()[\w(]/.test(line)) found.push(`${name}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
