/**
 * The search box's two jobs: do not send a request per keystroke, and do not
 * let a slow answer overwrite the results of what is on screen now.
 */
import { describe, it, expect, vi } from 'vitest';
import { SearchDebouncer, describeHit } from '../../src/partbank/partbankSearch';
import type { PartbankSearchHit } from '../../src/partbank/client';

/** A debouncer with a hand-driven clock, so no real time passes. */
function harness(search: (q: string) => Promise<string[]>) {
  const timers: { fn: () => void; id: number }[] = [];
  let nextId = 1;
  const results: [string, string[]][] = [];
  const errors: [string, unknown][] = [];
  const debouncer = new SearchDebouncer<string>({
    search,
    onResults: (q, r) => results.push([q, r]),
    onError: (q, e) => errors.push([q, e]),
    setTimer: fn => {
      const id = nextId++;
      timers.push({ fn, id });
      return id;
    },
    clearTimer: id => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    debouncer,
    results,
    errors,
    pending: () => timers.length,
    /** Fire every timer that is currently due. */
    tick: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    },
  };
}

describe('SearchDebouncer', () => {
  it('makes one request for a burst of typing', async () => {
    const calls: string[] = [];
    const h = harness(async q => {
      calls.push(q);
      return [q];
    });
    for (const text of ['gf', 'gfp', 'gfp-']) h.debouncer.query(text);
    expect(calls).toEqual([]);
    expect(h.pending()).toBe(1);
    h.tick();
    await vi.waitFor(() => expect(h.results).toHaveLength(1));
    expect(calls).toEqual(['gfp-']);
    expect(h.results[0]).toEqual(['gfp-', ['gfp-']]);
  });

  // Below the minimum every item matches, so the list is cleared instead.
  it('does not search a query that is too short', () => {
    const calls: string[] = [];
    const h = harness(async q => {
      calls.push(q);
      return [];
    });
    h.debouncer.query('g');
    expect(h.pending()).toBe(0);
    expect(h.results).toEqual([['g', []]]);
    h.debouncer.query('   ');
    expect(calls).toEqual([]);
  });

  it('trims the query it sends', async () => {
    const calls: string[] = [];
    const h = harness(async q => {
      calls.push(q);
      return [];
    });
    h.debouncer.query('  gfp  ');
    h.tick();
    await vi.waitFor(() => expect(calls).toEqual(['gfp']));
  });

  // A slow answer for "gf" arriving after "gfp" was typed would show the wrong
  // list under the right text.
  it('ignores the answer to a query that is no longer on screen', async () => {
    const settle = new Map<string, (v: string[]) => void>();
    const h = harness(q => new Promise<string[]>(resolve => settle.set(q, resolve)));

    h.debouncer.query('gf');
    h.tick();
    h.debouncer.query('gfp');
    h.tick();
    await vi.waitFor(() => expect(settle.size).toBe(2));

    settle.get('gfp')!(['fresh']);
    await vi.waitFor(() => expect(h.results).toEqual([['gfp', ['fresh']]]));
    settle.get('gf')!(['stale']);
    await Promise.resolve();
    expect(h.results).toEqual([['gfp', ['fresh']]]);
  });

  it('reports a failure of the query still on screen, and swallows the others', async () => {
    const settle = new Map<string, (e: unknown) => void>();
    const h = harness(q => new Promise<string[]>((_r, reject) => settle.set(q, reject)));
    h.debouncer.query('gf');
    h.tick();
    h.debouncer.query('gfp');
    h.tick();
    await vi.waitFor(() => expect(settle.size).toBe(2));

    settle.get('gf')!(new Error('slow'));
    await Promise.resolve();
    expect(h.errors).toEqual([]);
    settle.get('gfp')!(new Error('boom'));
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.errors[0][0]).toBe('gfp');
  });

  it('drops a request that has not gone out yet when cancelled', () => {
    const calls: string[] = [];
    const h = harness(async q => {
      calls.push(q);
      return [];
    });
    h.debouncer.query('gfp');
    h.debouncer.cancel();
    h.tick();
    expect(calls).toEqual([]);
  });
});

describe('describeHit', () => {
  const t = (key: string): string => key;
  const hit = (overrides: Partial<PartbankSearchHit>): PartbankSearchHit => ({
    type: 'part',
    id: 'abc',
    kid: 'KBp_aa0001',
    name: 'GFP',
    description: 'green protein',
    moleculeType: null,
    ownedByMe: false,
    sharingLevel: 'group',
    ...overrides,
  });

  // A public item from another lab looks the same as your own otherwise.
  it('says the KID, the kind, whose it is and what it is', () => {
    expect(describeHit(hit({ ownedByMe: true }), t)).toEqual({
      title: 'GFP',
      detail: 'KBp_aa0001 · part · mine · green protein',
    });
    expect(describeHit(hit({ sharingLevel: 'public' }), t).detail).toContain('public');
    expect(describeHit(hit({}), t).detail).toContain('shared');
  });

  it('calls a vector what partbank shows it as', () => {
    expect(describeHit(hit({ type: 'plasmid' }), t).detail).toContain('plasmid');
  });

  it('falls back to the KID, then the id, for a nameless item', () => {
    expect(describeHit(hit({ name: '  ' }), t).title).toBe('KBp_aa0001');
    expect(describeHit(hit({ name: null, kid: null }), t).title).toBe('abc');
  });

  it('leaves out the parts the item does not have', () => {
    expect(describeHit(hit({ kid: null, description: null, ownedByMe: true }), t).detail).toBe(
      'part · mine'
    );
  });
});
