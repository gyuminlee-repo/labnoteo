/**
 * What a sample record remembers about the partbank item it came from.
 *
 * Dependency-free on purpose: {@link SampleRecord} carries this field, and the
 * conversion logic in this folder reads `SampleRecord` back, so the shared type
 * has to sit below both.
 */

/** The six partbank resource kinds a sample can link to. */
export const PARTBANK_TYPES = [
  'part',
  'device',
  'plasmid',
  'primer',
  'molecule',
  'strain',
] as const;
export type PartbankType = (typeof PARTBANK_TYPES)[number];

/**
 * Which partbank a link points at. The desktop app's port is not fixed in
 * practice (the user moves it when 47830 is taken), so a desktop link is
 * matched by this tag alone rather than by its address; a web link also has to
 * match the origin, since several servers can exist.
 */
export type PartbankConnection = 'desktop' | 'web';

/** Where a sample came from. Only partbank exists today. */
export interface SampleSource {
  system: 'partbank';
  connection: PartbankConnection;
  /** The address it was fetched from, for display and for web matching. */
  origin: string;
  type: PartbankType;
  /** Mongo ObjectId: the only key partbank's detail endpoints accept. */
  id: string;
  /** Human-readable id (`KBp_aa0001`), when the item has one. */
  kid: string | null;
}

export function isPartbankType(value: unknown): value is PartbankType {
  return typeof value === 'string' && (PARTBANK_TYPES as readonly string[]).includes(value);
}

/** `origin` without a trailing slash, lowercased, for comparison. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/** Whether `origin` is the local machine, i.e. a desktop partbank on any port. */
export function isDesktopOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin.trim());
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Coerce an untrusted value into a {@link SampleSource}, or `null`. Anything
 * malformed is dropped rather than repaired: a half-built link would send
 * lookups to the wrong item.
 */
export function normalizeSampleSource(value: unknown): SampleSource | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SampleSource>;
  if (v.system !== 'partbank') return null;
  if (v.connection !== 'desktop' && v.connection !== 'web') return null;
  if (!isPartbankType(v.type)) return null;
  if (typeof v.id !== 'string' || !v.id.trim()) return null;
  if (typeof v.origin !== 'string' || !v.origin.trim()) return null;
  return {
    system: 'partbank',
    connection: v.connection,
    origin: v.origin.trim(),
    type: v.type,
    id: v.id.trim(),
    kid: typeof v.kid === 'string' && v.kid.trim() ? v.kid.trim() : null,
  };
}

/**
 * Whether two links point at the same partbank item. Desktop links compare by
 * connection alone (the port drifts); web links also compare the origin, so two
 * servers' items never collapse into one.
 */
export function isSameSampleSource(a: SampleSource, b: SampleSource): boolean {
  if (a.system !== b.system || a.connection !== b.connection) return false;
  if (a.connection === 'web' && normalizeOrigin(a.origin) !== normalizeOrigin(b.origin)) {
    return false;
  }
  return a.type === b.type && a.id === b.id;
}
