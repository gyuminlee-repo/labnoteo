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
  fencedCodeRanges,
  findIssueMarkerRanges,
  findSampleIdRanges,
  type IssueMarkerRange,
} from '@labnoteo/core';
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
}

const SAMPLE_ID_CLASS = 'labnote-sample-id';
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
  /** Tooltip for a marker whose ID is used again, undefined otherwise (#119). */
  duplicate?: (id: string) => string | undefined;
}

/**
 * Sample IDs plus `@issue` markers, ordered by position and non-overlapping.
 *
 * A marker owns the rest of its line, so a sample ID quoted inside a topic
 * sentence would nest inside it. Nested marks would break `RangeSetBuilder`'s
 * sorted-insert contract, so the marker wins and the sample ID inside it is
 * dropped. Sample IDs in code are kept, since the sample sync does register them.
 */
function collectTokenRanges(
  text: string,
  types: string[],
  colors: Record<string, string>,
  opts: MarkerOptions = {}
): TokenRange[] {
  const markers = findIssueMarkerRanges(text).filter(r => !opts.inCode?.(r.start, r.end));
  const ranges: TokenRange[] = markers.map(r => {
    const id = MARKER_ID_RE.exec(text.slice(r.start, r.end))?.[1];
    const title = id ? opts.duplicate?.(id) : undefined;
    return title === undefined
      ? { ...r, cls: ISSUE_MARKER_CLASS }
      : { ...r, cls: `${ISSUE_MARKER_CLASS} ${DUPLICATE_MARKER_CLASS}`, title };
  });

  for (const r of findSampleIdRanges(text, types)) {
    if (markers.some(m => r.start < m.end && r.end > m.start)) continue;
    ranges.push({ start: r.start, end: r.end, cls: SAMPLE_ID_CLASS, color: colors[r.type] ?? '' });
  }

  return ranges.sort((a, b) => a.start - b.start);
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
  return state.markerVersion === undefined ? key : `${key}\u0001${state.markerVersion}`;
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
      /** How often each marker ID appears in `fencedDoc`, off screen included. */
      ownIds = new Map<string, number>();
      fencedDoc: DocText | undefined;

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
          this.fenced = fencedCodeRanges(whole);
          this.ownIds = new Map();
          for (const id of noteMarkerIds(whole)) this.ownIds.set(id, (this.ownIds.get(id) ?? 0) + 1);
          this.fencedDoc = doc;
        }
        const { fenced, ownIds } = this;
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
          for (const r of collectTokenRanges(text, types, colors, { inCode, duplicate })) {
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

/** Reading-mode Markdown post-processor factory. */
export function createSampleReadingHighlighter(
  getState: (path: string | undefined) => HighlightState
): (el: HTMLElement, ctx: { sourcePath: string }) => void {
  return (el: HTMLElement, ctx: { sourcePath: string }) => {
    const { types, colors } = getState(ctx.sourcePath);
    highlightTextNodes(el, types, colors);
  };
}

function highlightTextNodes(
  root: HTMLElement,
  types: string[],
  colors: Record<string, string>
): void {
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
    const ranges = collectTokenRanges(text, types, colors);
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const r of ranges) {
      if (r.start > last) frag.appendChild(document.createTextNode(text.slice(last, r.start)));
      const span = document.createElement('span');
      span.className = r.cls;
      span.textContent = text.slice(r.start, r.end);
      if (r.color) span.style.setProperty('--labnote-sample-color', r.color);
      frag.appendChild(span);
      last = r.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.replaceWith(frag);
  }
}
