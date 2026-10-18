// Globals convention (no `import ... from 'vitest'`) — matches the core tests.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVaultRoot, vaultRootFromScript } from './vaultRoot';

describe('vaultRootFromScript (#129)', () => {
  it('finds the vault two folders above an installed script', () => {
    expect(vaultRootFromScript('/home/me/vault/.labnoteo/scripts/validate.mjs')).toBe('/home/me/vault');
  });

  it('reads Windows paths', () => {
    expect(vaultRootFromScript('C:\\Users\\me\\vault\\.labnoteo\\scripts\\validate.mjs')).toBe(
      'C:\\Users\\me\\vault'
    );
    expect(vaultRootFromScript('D:\\.labnoteo\\scripts\\validate.mjs')).toBe('D:\\');
  });

  it('leaves scripts outside .labnoteo/scripts to the working folder', () => {
    expect(vaultRootFromScript('/repo/dist-automation/validate.mjs')).toBeUndefined();
    expect(vaultRootFromScript('/repo/automation/src/validate.ts')).toBeUndefined();
    expect(vaultRootFromScript('/vault/.labnoteo/hooks/pre-commit')).toBeUndefined();
  });
});

describe('isVaultRoot', () => {
  it('needs a .labnoteo folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'labnoteo-root-'));
    try {
      expect(isVaultRoot(dir)).toBe(false);
      mkdirSync(join(dir, '.labnoteo'));
      expect(isVaultRoot(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
