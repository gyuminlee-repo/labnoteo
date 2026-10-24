import { describe, it, expect } from 'vitest';
import { confirmButtonStyle } from '../../src/modals';

// #285: every confirm button was red, so "Insert" read like a deletion.
describe('confirmButtonStyle', () => {
  it('keeps red for what cannot be undone and the accent colour otherwise', () => {
    expect(confirmButtonStyle(true)).toBe('warning');
    expect(confirmButtonStyle(false)).toBe('cta');
  });
});
