/**
 * The client's job is to be precise about two things: which address a key may
 * be sent to, and what a failure means. Both are checked here against the
 * `requestUrl` stub, so no test reaches the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __setRequestUrlHandler,
  type RequestUrlParam,
  type RequestUrlResponse,
} from '../stubs/obsidian';
import {
  PartbankClient,
  PartbankError,
  connectionForOrigin,
  connectionForSource,
  type PartbankConnectionConfig,
} from '../../src/partbank/client';
import type { SampleSource } from '@labnoteo/core';
import { PartbankFeature } from '../../src/partbank/partbankFeature';
import type LabnotePlugin from '../../src/main';

const WEB = 'https://partbank.kbiofoundry.kr';
const DESKTOP = 'http://127.0.0.1:47830';

const webClient = (): PartbankClient =>
  new PartbankClient({ kind: 'web', url: WEB, apiKey: 'pbk_secret' });
const desktopClient = (): PartbankClient =>
  new PartbankClient({ kind: 'desktop', url: DESKTOP, apiKey: 'pbk_local' });

/** Record every request and answer each with the next queued response. */
function stub(responses: Partial<RequestUrlResponse>[]): RequestUrlParam[] {
  const seen: RequestUrlParam[] = [];
  let i = 0;
  __setRequestUrlHandler(param => {
    seen.push(param);
    const next = responses[Math.min(i++, responses.length - 1)];
    return { status: 200, text: '', headers: {}, ...next } as RequestUrlResponse;
  });
  return seen;
}

const json = (body: unknown): Partial<RequestUrlResponse> => ({
  status: 200,
  text: JSON.stringify(body),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  __setRequestUrlHandler(null);
});

describe('requests', () => {
  it('sends the key as X-API-Key against the configured origin', async () => {
    const seen = stub([json({ username: 'hs' })]);
    await expect(desktopClient().whoAmI()).resolves.toBe('hs');
    expect(seen[0].url).toBe(`${DESKTOP}/api/v1/auth/me`);
    expect(seen[0].headers?.['X-API-Key']).toBe('pbk_local');
    // A 404 has to be readable as a message, not thrown as a stack trace.
    expect(seen[0].throw).toBe(false);
  });

  it('falls back to the email when the account has no username', async () => {
    stub([json({ email: 'me@lab.kr' })]);
    await expect(webClient().whoAmI()).resolves.toBe('me@lab.kr');
  });

  it('drops a trailing slash from the configured address', async () => {
    const seen = stub([json({ username: 'hs' })]);
    await new PartbankClient({ kind: 'web', url: `${WEB}/`, apiKey: 'k' }).whoAmI();
    expect(seen[0].url).toBe(`${WEB}/api/v1/auth/me`);
  });
});

describe('searchGlobal', () => {
  it('posts the query and reads the rows back as items', async () => {
    const seen = stub([
      json({
        results: [
          {
            id: '507f1f77bcf86cd799439011',
            kid: 'KBvt_aa0001',
            name: 'pTrc99A_GFP',
            type: 'vector',
            description: 'green',
            owner_is_me: true,
            sharing_level: 'private',
          },
        ],
      }),
    ]);
    const hits = await desktopClient().searchGlobal('gfp', ['vector', 'part']);
    expect(JSON.parse(seen[0].body as string)).toEqual({
      query: 'gfp',
      types: ['vector', 'part'],
      limit: 10,
    });
    // `vector` is partbank's name for an as-built plasmid.
    expect(hits).toEqual([
      {
        type: 'plasmid',
        id: '507f1f77bcf86cd799439011',
        kid: 'KBvt_aa0001',
        name: 'pTrc99A_GFP',
        description: 'green',
        moleculeType: null,
        ownedByMe: true,
        sharingLevel: 'private',
      },
    ]);
  });

  it('skips rows without a usable id or type', async () => {
    stub([json({ results: [{ id: 'a' }, { type: 'part' }, 'junk', { id: 'b', type: 'storage' }] })]);
    await expect(desktopClient().searchGlobal('x', ['part'])).resolves.toEqual([]);
  });

  it('makes no call for a blank query or an empty entity list', async () => {
    const seen = stub([json({ results: [] })]);
    await desktopClient().searchGlobal('  ', ['part']);
    await desktopClient().searchGlobal('gfp', []);
    expect(seen).toEqual([]);
  });
});

describe('getStocks', () => {
  it('asks the by-resource endpoint for the type as partbank names it', async () => {
    const seen = stub([json({ items: [{ hole_position: 'A1' }] })]);
    const stocks = await desktopClient().getStocks('plasmid', 'abc');
    expect(seen[0].url).toBe(`${DESKTOP}/api/v1/stock-box/by-resource/plasmid/abc`);
    expect(stocks).toEqual([{ hole_position: 'A1' }]);
  });

  it('reads a missing items array as no stock', async () => {
    stub([json({})]);
    await expect(desktopClient().getStocks('part', 'abc')).resolves.toEqual([]);
  });
});

describe('listAll', () => {
  it('walks the pages until a short one comes back', async () => {
    const page = (n: number, from: number): unknown =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, kid: `KBp_aa000${from + i}` }));
    const seen = stub([json({ items: page(200, 0) }), json({ items: page(3, 200) })]);
    const items = await desktopClient().listAll('part');
    expect(items).toHaveLength(203);
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toContain('/api/v1/workspace/parts?skip=0&limit=200');
    expect(seen[1].url).toContain('skip=200');
    expect(items[0]).toEqual({
      type: 'part',
      id: 'id-0',
      kid: 'KBp_aa0000',
      name: null,
      description: null,
      moleculeType: null,
    });
  });

  // A server that ignored `skip` would otherwise return the same page forever.
  it('stops once it has as many items as the total says', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}` }));
    const seen = stub([json({ items: full, total: 200 })]);
    await expect(desktopClient().listAll('part')).resolves.toHaveLength(200);
    expect(seen).toHaveLength(1);
  });
});

describe('failures', () => {
  const kinds: [number, string][] = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [429, 'rateLimited'],
    [500, 'server'],
    [0, 'offline'],
  ];

  for (const [status, kind] of kinds) {
    it(`reads ${status} as ${kind}`, async () => {
      stub([{ status, text: 'nope' }]);
      await expect(desktopClient().whoAmI()).rejects.toMatchObject({ kind, status });
    });
  }

  it('reads a thrown request as being offline', async () => {
    __setRequestUrlHandler(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(desktopClient().whoAmI()).rejects.toMatchObject({ kind: 'offline' });
  });

  // #278: a site's front page answered 200 and read as "Connected." or a server error.
  it('reads a non-JSON body as not being partbank', async () => {
    stub([{ status: 200, text: '<html>login</html>' }]);
    await expect(desktopClient().whoAmI()).rejects.toMatchObject({ kind: 'notPartbank' });
  });

  it('reads an account answer without a username or email as not being partbank', async () => {
    for (const body of [{}, { ok: true }, null, { username: '  ' }]) {
      stub([json(body)]);
      await expect(webClient().whoAmI()).rejects.toMatchObject({ kind: 'notPartbank' });
    }
  });

  // `requestUrl` has no timeout of its own, so a stalled call would hang.
  it('gives up on a call that never answers', async () => {
    __setRequestUrlHandler(
      (() => new Promise(() => {})) as unknown as (p: RequestUrlParam) => RequestUrlResponse
    );
    const pending = desktopClient().whoAmI();
    const assertion = expect(pending).rejects.toBeInstanceOf(PartbankError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

describe('web call spacing', () => {
  // The server allows 100 calls a minute per IP, shared with the browser tab
  // the same person may have partbank open in.
  it('leaves a gap between web calls but not desktop ones', async () => {
    stub([json({ username: 'hs' })]);
    const web = webClient();
    await web.whoAmI();
    let done = false;
    void web.whoAmI().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);

    const desktop = desktopClient();
    await desktop.whoAmI();
    let desktopDone = false;
    void desktop.whoAmI().then(() => (desktopDone = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(desktopDone).toBe(true);
  });
});

describe('picking the connection for a link', () => {
  const connections: PartbankConnectionConfig[] = [
    { kind: 'desktop', url: DESKTOP, apiKey: 'k1' },
    { kind: 'web', url: WEB, apiKey: 'k2' },
  ];
  const source = (overrides: Partial<SampleSource>): SampleSource => ({
    system: 'partbank',
    connection: 'web',
    origin: WEB,
    type: 'part',
    id: 'abc',
    kid: null,
    ...overrides,
  });

  // The desktop port drifts, so a link made on 47830 must still resolve.
  it('matches a desktop link whatever port it was made on', () => {
    const hit = connectionForSource(
      source({ connection: 'desktop', origin: 'http://127.0.0.1:47999' }),
      connections
    );
    expect(hit?.kind).toBe('desktop');
  });

  it('matches a web link only on the same server', () => {
    expect(connectionForSource(source({}), connections)?.kind).toBe('web');
    expect(connectionForSource(source({ origin: 'https://other.kr' }), connections)).toBeUndefined();
  });

  it('has no connection when the matching one is not set up', () => {
    expect(connectionForSource(source({ connection: 'desktop' }), [connections[1]])).toBeUndefined();
  });

  // The URI names an origin to *match*; the address called is the stored one.
  it('resolves an external origin to a configured connection', () => {
    expect(connectionForOrigin(`${WEB}/`, connections)?.url).toBe(WEB);
    expect(connectionForOrigin('http://localhost:47830', connections)?.kind).toBe('desktop');
    expect(connectionForOrigin('https://evil.example.com', connections)).toBeUndefined();
    expect(connectionForOrigin('', connections)).toBeUndefined();
  });
});

// #278: Test connection against a wrong address said "item no longer in partbank" or "Connected."
describe('describeProbeError', () => {
  const plugin = {
    t: (key: string) => key,
    settings: { partbankDesktopUrl: DESKTOP, partbankWebUrl: WEB, partbankDefaultConnection: 'web' },
  } as unknown as LabnotePlugin;
  const feature = new PartbankFeature(plugin, { get: () => undefined, set: () => undefined });

  it('says no partbank API is at the address for a 404 or a foreign answer', () => {
    for (const kind of ['notFound', 'notPartbank'] as const) {
      expect(feature.describeProbeError(new PartbankError(kind, 404, ''), 'web')).toBe(
        'No partbank API was found at this address. Check the address.'
      );
    }
  });

  it('leaves the other failures to describeError', () => {
    const err = new PartbankError('unauthorized', 401, '');
    expect(feature.describeProbeError(err, 'web')).toBe(feature.describeError(err, 'web'));
    expect(feature.describeError(new PartbankError('notPartbank', 200, ''), 'web')).toBe(
      'The address answered, but not as partbank does. Check the partbank address in the settings.'
    );
  });
});
