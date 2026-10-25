/**
 * Inline-token highlighting for both Obsidian editing surfaces:
 *
 * - **Live Preview / Source** — a CodeMirror 6 `ViewPlugin` that decorates the
 *   visible ranges.
 * - **Reading mode** — a Markdown post-processor that wraps matches in the
 *   rendered HTML.
 *
 * Two kinds of token are decorated: sample IDs and `@issue` markers. Both share
 * their pure scanners with `@labnoteo/core`, so the two views stay perfectly
 * consistent and the logic is unit-tested in core rather than here.
 *
 * For `@issue` the highlight doubles as validation feedback: only well-formed
 * markers are styled, so one that stays plain is one that will open no issue.
 */
import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Text as DocText } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import {
  codeBlockRanges,
  findIssueMarkerRanges,
  markerHiddenRanges,
  findSampleIdRanges,
  markerSpanAcrossRuns,
  staleSampleAliasEnd,
  type IssueMarkerRange,
} from '@labnoteo/core';
import { findDefinedSampleIds } from '@labnoteo/core/lib/sampleStorage';
import { noteMarkerIds } from './issueMarkerIndex';

export interface HighlightState {
  types: string[];
  colors: Record<string, string>;
  /** Marker ID → name of another note of the experiment that uses it (#119). */
  otherMarkerIds?: ReadonlyMap<string, string>;
  /** Changes whenever `otherMarkerIds` may have, so the editor redraws. */
  markerVersion?: number;
  /** Tooltip of a duplicate marker; `owner` is undefined when this note repeats the ID. */
  duplicateTitle?: (owner: string | undefined) => string;
  /** Lower-cased sample IDs the note can resolve; without it no ID is marked missing (#210). */
  knownIds?: ReadonlySet<string>;
  /** Changes whenever `knownIds` may have, so the editor redraws. */
  sampleVersion?: number;
  /** Tooltip of a sample ID the registry does not have. */
  missingTitle?: string;
  /** Registry aliases by lower-cased ID, read with `knownIds` (#239). */
  knownAliases?: ReadonlyMap<string, string>;
  /** Tooltip of a reference whose alias differs from the registry's `alias`. */
  staleAliasTitle?: (alias: string) => string;
  /** Discard dates by lower-cased ID, read with `knownIds` (#330). */
  discardedIds?: ReadonlyMap<string, string>;
  /** Tooltip of a reference to a discarded sample. */
  discardedTitle?: (date: string) => string;
}

const SAMPLE_ID_CLASS = 'labnote-sample-id';
const MISSING_SAMPLE_CLASS = 'labnote-sample-id-missing';
const STALE_ALIAS_CLASS = 'labnote-sample-alias-stale';
const DISCARDED_SAMPLE_CLASS = 'labnote-sample-discarded';
const ISSUE_MARKER_CLASS = 'labnote-issue-marker';
const DUPLICATE_MARKER_CLASS = 'labnote-issue-marker-duplicate';
const MARKER_ID_RE = /^@issue[;:]([A-Za-z0-9-]+)/i;

/** One span to decorate, with the class and optional colour or tooltip it carries. */
interface TokenRange {
  start: number;
  end: number;
  cls: string;
  color?: string;
  title?: string;
}

/** Which markers to draw, and how, in the editor. */
interface MarkerOptions {
  /** Drops the markers the automation will not read (#120). */
  inCode?: (start: number, end: number) => boolean;
  /** Whether a marker starting here is in a comment, which the automation does not read either (#266). */
  inComment?: (at: number) => boolean;
  /** Tooltip for a marker whose ID is used again, undefined otherwise (#119). */
  duplicate?: (id: string) => string | undefined;
  /** Tooltip for a sample ID the note cannot resolve, undefined otherwise (#210). */
  missing?: (id: string) => string | undefined;
  /** The registry alias of a sample ID to hold its references to, with the tooltip for one that differs (#239). */
  staleAlias?: (id: string) => { alias: string; title: string } | undefined;
  /** Tooltip for a discarded sample's ID, undefined otherwise (#330). */
  discarded?: (id: string) => string | undefined;
  /** The text stops where reading view split it, e.g. before a link (#329). */
  cut?: boolean;
}

/**
 * Tooltip for the sample IDs of a note that are neither in its registries nor
 * defined in the note itself, which the sample sync has yet to save.
 */
export function missingSampleCheck(
  state: HighlightState,
  definedIds: ReadonlySet<string>
): ((id: string) => string | undefined) | undefined {
  const known = state.knownIds;
  if (!known) return undefined;
  const title = state.missingTitle ?? '';
  return id => {
    const key = id.toLowerCase();
    return known.has(key) || definedIds.has(key) ? undefined : title;
  };
}

/**
 * The registry alias that a note's references to a sample should carry. Not
 * for the samples the note defines itself: the sample sync writes their alias
 * to the registry on save.
 */
export function staleAliasCheck(state: HighlightState, definedIds: ReadonlySet<string>): MarkerOptions['staleAlias'] {
  const aliases = state.knownAliases;
  if (!aliases) return undefined;
  return id => {
    const key = id.toLowerCase();
    const alias = aliases.get(key);
    if (!alias || definedIds.has(key)) return undefined;
    return { alias, title: state.staleAliasTitle?.(alias) ?? '' };
  };
}

/** Tooltip for the references of a note to a discarded sample (#330). */
export function discardedSampleCheck(state: HighlightState): MarkerOptions['discarded'] {
  const dates = state.discardedIds;
  if (!dates) return undefined;
  return id => {
    const date = dates.get(id.toLowerCase());
    return date === undefined ? undefined : state.discardedTitle?.(date) ?? '';
  };
}

/**
 * Sample IDs plus `@issue` markers, ordered by position and non-overlapping.
 *
 * A marker owns the rest of its line, so a sample ID quoted inside a topic
 * sentence would nest inside it. Nested marks would break `RangeSetBuilder`'s
 * sorted-insert contract, so the marker wins and the sample ID inside it is
 * dropped. Sample IDs in code are kept, since the sample sync does register them.
 */
export function collectTokenRanges(
  text: string,
  types: string[],
  colors: Record<string, string>,
  opts: MarkerOptions = {}
): TokenRange[] {
  const markers = findIssueMarkerRanges(text, opts.inComment).filter(r => !opts.inCode?.(r.start, r.end));
  const ranges: TokenRange[] = markers.map(r => {
    const id = MARKER_ID_RE.exec(text.slice(r.start, r.end))?.[1];
    const title = id ? opts.duplicate?.(id) : undefined;
    return title === undefined
      ? { ...r, cls: ISSUE_MARKER_CLASS }
      : { ...r, cls: `${ISSUE_MARKER_CLASS} ${DUPLICATE_MARKER_CLASS}`, title };
  });

  for (const r of findSampleIdRanges(text, types)) {
    if (markers.some(m => r.start < m.end && r.end > m.start)) continue;
    const color = colors[r.type] ?? '';
    const id = text.slice(r.start, r.end);
    const title = opts.missing?.(id);
    if (title !== undefined) {
      ranges.push({ start: r.start, end: r.end, cls: `${SAMPLE_ID_CLASS} ${MISSING_SAMPLE_CLASS}`, color, title });
      continue;
    }
    const stale = opts.staleAlias?.(id);
    const end = stale ? staleSampleAliasEnd(text, r.end, stale.alias, opts.cut) : undefined;
    const range: TokenRange =
      stale && end !== undefined
        ? { start: r.start, end, cls: `${SAMPLE_ID_CLASS} ${STALE_ALIAS_CLASS}`, color, title: stale.title }
        : { start: r.start, end: r.end, cls: SAMPLE_ID_CLASS, color };
    const discarded = opts.discarded?.(id);
    if (discarded !== undefined) {
      range.cls = `${range.cls} ${DISCARDED_SAMPLE_CLASS}`;
      range.title = range.title ? `${discarded}\n${range.title}` : discarded;
    }
    ranges.push(range);
  }

  // A stale alias's mark reaches past its ID and may cover the next one.
  let last = 0;
  return ranges
    .sort((a, b) => a.start - b.start)
    .filter(r => {
      if (r.start < last) return false;
      last = r.end;
      return true;
    });
}

/**
 * Per-type colour is dynamic (built-ins + custom fallback), so it is handed to
 * the stylesheet through the `--labnote-sample-color` custom property rather than
 * a hardcoded `style` declaration. Returns `undefined` when no colour applies so
 * the caller can skip emitting the variable entirely (avoids the old invalid
 * `background-color:;`).
 */
function sampleColorVar(color: string): string | undefined {
  return color ? `--labnote-sample-color: ${color}` : undefined;
}

/** What a set of decorations was drawn for; a different key means redraw. */
export function highlightStateKey(state: HighlightState): string {
  const key = state.types.map(t => `${t}=${state.colors[t] ?? ''}`).join('\u0000');
  const marker = state.markerVersion === undefined ? key : `${key}\u0001${state.markerVersion}`;
  return state.sampleVersion === undefined ? marker : `${marker}\u0002${state.sampleVersion}`;
}

/**
 * Whether the editor's decorations are stale: the text or the visible ranges
 * moved, or the note's state changed under it — its experiment README turned
 * `sample_tracking` off or on (#105) — which changes neither.
 */
export function needsHighlightRebuild(
  u: { docChanged: boolean; viewportChanged: boolean },
  drawnKey: string,
  currentKey: string
): boolean {
  return u.docChanged || u.viewportChanged || drawnKey !== currentKey;
}

/** The note an editor shows, for {@link createSampleHighlightPlugin}'s `getState`. */
function editorPath(view: EditorView): string | undefined {
  return view.state.field(editorInfoField, false)?.file?.path;
}

/** CM6 ViewPlugin factory. `getState` is read for the editor's note on every
 *  update so settings and README changes take effect without re-registering. */
export function createSampleHighlightPlugin(getState: (path: string | undefined) => HighlightState) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      drawnKey = '';
      /** Fenced code of `fencedDoc`; a fence may open outside the visible ranges. */
      fenced: IssueMarkerRange[] = [];
      /** Comments of `fencedDoc`, which may open outside the visible ranges too (#266). */
      comments: IssueMarkerRange[] = [];
      /** How often each marker ID appears in `fencedDoc`, off screen included. */
      ownIds = new Map<string, number>();
      fencedDoc: DocText | undefined;
      /** Sample IDs `definedDoc` defines, off screen included, for the types of `definedTypes`. */
      definedIds: ReadonlySet<string> = new Set();
      definedDoc: DocText | undefined;
      definedTypes = '';

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        if (needsHighlightRebuild(u, this.drawnKey, highlightStateKey(getState(editorPath(u.view))))) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const state = getState(editorPath(view));
        this.drawnKey = highlightStateKey(state);
        const { types, colors } = state;
        const doc = view.state.doc;
        // Scrolling keeps the same document, so the scan runs once per edit.
        if (this.fencedDoc !== doc) {
          const whole = doc.toString();
          this.fenced = codeBlockRanges(whole);
          this.comments = markerHiddenRanges(whole);
          this.ownIds = new Map();
          for (const id of noteMarkerIds(whole)) this.ownIds.set(id, (this.ownIds.get(id) ?? 0) + 1);
          this.fencedDoc = doc;
        }
        const typesKey = types.join('\u0000');
        if (state.knownIds && (this.definedDoc !== doc || this.definedTypes !== typesKey)) {
          this.definedIds = findDefinedSampleIds(doc.toString(), types);
          this.definedDoc = doc;
          this.definedTypes = typesKey;
        }
        const missing = missingSampleCheck(state, this.definedIds);
        const staleAlias = staleAliasCheck(state, this.definedIds);
        const discarded = discardedSampleCheck(state);
        const { fenced, comments, ownIds } = this;
        // The open note counts as typed, the others as last saved.
        const duplicate = (id: string): string | undefined => {
          // Only an experiment's notes share issues; elsewhere nothing is read.
          if (!state.otherMarkerIds) return undefined;
          const owner = state.otherMarkerIds.get(id);
          if (owner === undefined && (ownIds.get(id) ?? 0) < 2) return undefined;
          return state.duplicateTitle?.(owner) ?? '';
        };
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          const text = doc.sliceString(from, to);
          const inCode = (start: number, end: number): boolean =>
            fenced.some(f => from + start < f.end && from + end > f.start);
          const inComment = (at: number): boolean => comments.some(c => from + at >= c.start && from + at < c.end);
          for (const r of collectTokenRanges(text, types, colors, {
            inCode,
            inComment,
            duplicate,
            missing,
            staleAlias,
            discarded,
          })) {
            const styleVar = sampleColorVar(r.color ?? '');
            const attributes: Record<string, string> = {};
            if (styleVar) attributes.style = styleVar;
            if (r.title) attributes.title = r.title;
            const deco = Decoration.mark({ class: r.cls, attributes });
            builder.add(from + r.start, from + r.end, deco);
          }
        }
        return builder.finish();
      }
    },
    { decorations: v => v.decorations }
  );
}

/** What the reading-mode post-processor reads of its context. */
interface ReadingContext {
  sourcePath: string;
  /** `text` is the whole note the section belongs to. */
  getSectionInfo?: (el: HTMLElement) => { text: string } | null;
}

/** Reading-mode Markdown post-processor factory. */
export function createSampleReadingHighlighter(
  getState: (path: string | undefined) => HighlightState
): (el: HTMLElement, ctx: ReadingContext) => void {
  // Every section of a note hands over the same note text.
  let definedText: string | undefined;
  let definedIds: ReadonlySet<string> = new Set();
  return (el: HTMLElement, ctx: ReadingContext) => {
    const state = getState(ctx.sourcePath);
    const { types, colors } = state;
    let missing: MarkerOptions['missing'];
    let staleAlias: MarkerOptions['staleAlias'];
    let discarded: MarkerOptions['discarded'];
    if (state.knownIds) {
      const text = ctx.getSectionInfo?.(el)?.text ?? '';
      if (text !== definedText) {
        definedIds = findDefinedSampleIds(text, types);
        definedText = text;
      }
      missing = missingSampleCheck(state, definedIds);
      staleAlias = staleAliasCheck(state, definedIds);
      discarded = discardedSampleCheck(state);
    }
    highlightTextNodes(el, types, colors, { missing, staleAlias, discarded });
  };
}

/** Elements that stay on the line of the text before them; anything else ends it. */
const INLINE_TAGS = new Set(['A', 'B', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD', 'MARK', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U']);

/**
 * Wrap each marker whose topic runs into a link, code, bold or italics in
 * one marker span, those elements included (#292). Done before the text
 * nodes are styled, so the sample IDs inside such a marker stay plain, as
 * they do in a marker of plain text.
 */
function wrapFormattedMarkers(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const starts: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    if (!/@issue[;:]/i.test(textNode.data)) continue;
    if (textNode.parentElement?.closest(`code, pre, a, .${ISSUE_MARKER_CLASS}`)) continue;
    starts.push(textNode);
  }
  for (const textNode of starts) {
    const line: ChildNode[] = [];
    for (let n = textNode.nextSibling; n; n = n.nextSibling) {
      const inline = n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(n.nodeName));
      if (!inline) break;
      line.push(n);
    }
    const runs = [textNode, ...line].map(n => ({ text: n.textContent ?? '', isText: n.nodeType === Node.TEXT_NODE }));
    const span = markerSpanAcrossRuns(runs);
    if (!span) continue;
    const taken = line.slice(0, span.lastRun);
    const last = taken[taken.length - 1];
    if (last.nodeType === Node.TEXT_NODE && span.endInLast < (last as Text).length) (last as Text).splitText(span.endInLast);
    const marker = textNode.splitText(span.start);
    const el = document.createElement('span');
    el.className = ISSUE_MARKER_CLASS;
    marker.before(el);
    el.append(marker, ...taken);
  }
}

function highlightTextNodes(
  root: HTMLElement,
  types: string[],
  colors: Record<string, string>,
  opts: MarkerOptions = {}
): void {
  wrapFormattedMarkers(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (!parent) continue;
    // Skip code, links and already-processed spans.
    if (parent.closest(`code, pre, a, .${SAMPLE_ID_CLASS}, .${ISSUE_MARKER_CLASS}`)) continue;
    if (collectTokenRanges(textNode.data, types, colors).length > 0) targets.push(textNode);
  }

  for (const textNode of targets) {
    const text = textNode.data;
    const next = textNode.nextSibling;
    const cut = next?.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(next.nodeName);
    const ranges = collectTokenRanges(text, types, colors, { ...opts, cut });
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const r of ranges) {
      if (r.start > last) frag.appendChild(document.createTextNode(text.slice(last, r.start)));
      const span = document.createElement('span');
      span.className = r.cls;
      span.textContent = text.slice(r.start, r.end);
      if (r.color) span.style.setProperty('--labnote-sample-color', r.color);
      if (r.title) span.title = r.title;
      frag.appendChild(span);
      last = r.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.replaceWith(frag);
  }
}
