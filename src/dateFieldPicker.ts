/**
 * Click-to-pick date/time editing for unit operation `#### Meta` blocks.
 *
 * A CodeMirror 6 `ViewPlugin` marks the value of every `- Start_date: '…'` /
 * `- End_date: '…'` line as clickable and adds a small calendar affordance at
 * the end of the line, which is the only thing to click while the value is
 * still empty. Clicking opens the platform's native date/time picker via
 * `<input type="datetime-local">` and writes the chosen value back through
 * editor transactions, so undo/redo and Obsidian's own save pipeline keep
 * working normally.
 *
 * Line parsing lives in `@labnoteo/core/lib/dateUtils` ({@link findMetaDateFieldInLine})
 * so it stays unit-tested and shared with any other consumer.
 *
 * Only the editing surfaces (Live Preview / Source) are covered — reading mode
 * is read-only by design.
 */
import {
  ViewPlugin,
  Decoration,
  WidgetType,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { Prec, RangeSetBuilder } from '@codemirror/state';
import {
  findMetaDateFieldInLine,
  fromDateTimeLocalValue,
  getSeoulDateTimeString,
  toDateTimeLocalValue,
} from '@labnoteo/core/lib/dateUtils';

const VALUE_CLASS = 'labnote-date-value';
const ICON_CLASS = 'labnote-date-pick';
const PICKER_CLASS = 'labnote-datetime-picker';

/** The field that is open, if any; at most one exists at a time. */
let openPicker: { commit: () => void; cancel: () => void; close: () => void } | null = null;

/** Calendar affordance rendered at the end of every date field line. */
class DatePickIconWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly lineNumber: number
  ) {
    super();
  }

  eq(other: DatePickIconWidget): boolean {
    return other.label === this.label && other.lineNumber === this.lineNumber;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = ICON_CLASS;
    el.textContent = '📅';
    el.setAttribute('aria-label', this.label);
    // mousedown only suppresses the caret jump; the field opens on click, once
    // the editor has settled, so nothing steals focus from it afterwards.
    el.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    el.addEventListener('click', event => {
      openPickerOnLine(view, this.lineNumber, event.clientX, event.clientY);
    });
    return el;
  }
}

/**
 * Editor extension enabling the click-to-pick behaviour. `label` is the
 * localized tooltip for the calendar affordance.
 */
export function createMetaDatePickerExtension(label: string) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            const match = findMetaDateFieldInLine(line.text);
            if (match) {
              if (match.valueEnd > match.valueStart) {
                builder.add(
                  line.from + match.valueStart,
                  line.from + match.valueEnd,
                  Decoration.mark({ class: VALUE_CLASS })
                );
              }
              // Always offered, filled or not, so the field has one entry
              // point that does not depend on hitting the value text (#85).
              builder.add(
                line.to,
                line.to,
                Decoration.widget({
                  widget: new DatePickIconWidget(label, line.number),
                  side: 1,
                })
              );
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: v => v.decorations }
  );

  return [
    plugin,
    // The editor can win focus back after the field opens (#85). Enter and
    // Escape then reach the editor, so while a field is open they act on the
    // field instead of splitting the line under it.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: event => {
          if (!openPicker || (event.key !== 'Enter' && event.key !== 'Escape')) return false;
          event.preventDefault();
          if (event.key === 'Enter') openPicker.commit();
          else openPicker.cancel();
          return true;
        },
      })
    ),
    EditorView.domEventHandlers({
      // `click`, so the editor has finished placing the caret and taking focus
      // before the field opens and focuses itself. Not consumed: the caret
      // still lands on the value, keeping it editable by hand as well.
      click: (event, view) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest(`.${VALUE_CLASS}`)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        openPickerOnLine(view, view.state.doc.lineAt(pos).number, event.clientX, event.clientY);
        return false;
      },
    }),
  ];
}

/** Open the picker for the Meta date field on the given line. */
function openPickerOnLine(view: EditorView, lineNumber: number, x: number, y: number): void {
  if (lineNumber > view.state.doc.lines) return;
  const line = view.state.doc.line(lineNumber);
  const match = findMetaDateFieldInLine(line.text);
  if (!match) return;

  const initial =
    toDateTimeLocalValue(match.value) || toDateTimeLocalValue(getSeoulDateTimeString());
  const originalLine = line.text;
  let written = false;

  // The document may have changed while the picker was open, so the target
  // line is resolved again on every write instead of trusting captured offsets.
  const currentLine = () => {
    if (lineNumber > view.state.doc.lines) return null;
    const current = view.state.doc.line(lineNumber);
    const target = findMetaDateFieldInLine(current.text);
    return target && target.field === match.field ? { current, target } : null;
  };

  openDateTimePicker({
    x,
    y,
    initial,
    onPick: picked => {
      const value = fromDateTimeLocalValue(picked);
      const found = value ? currentLine() : null;
      if (!value || !found) return;
      const { current, target } = found;
      view.dispatch({
        changes: {
          from: current.from + target.valueStart,
          to: current.from + target.valueEnd,
          insert: target.quote ? value : `'${value}'`,
        },
        userEvent: 'input.date',
      });
      written = true;
    },
    onClose: reason => {
      if (reason === 'cancel' && written) {
        const found = currentLine();
        if (found) {
          view.dispatch({
            changes: { from: found.current.from, to: found.current.to, insert: originalLine },
            userEvent: 'input.date',
          });
        }
      }
      // Deferred so the key that closed the field has finished before the
      // editor takes focus; otherwise its default action lands there (#85).
      // A click elsewhere decides focus by itself.
      if (reason !== 'outside') window.setTimeout(() => view.focus(), 0);
    },
  });
}

/** How the field was closed: kept (Enter), reverted (Escape) or clicked away. */
type PickerCloseReason = 'commit' | 'cancel' | 'outside';

interface DateTimePickerOptions {
  x: number;
  y: number;
  /** `YYYY-MM-DDTHH:mm`, the value shape `datetime-local` expects. */
  initial: string;
  /** Write a chosen value into the note. May run more than once per field. */
  onPick: (value: string) => void;
  onClose: (reason: PickerCloseReason) => void;
}

/**
 * Show a `datetime-local` field at the given viewport coordinates.
 *
 * The field itself is the picker: it is visible and focused, so the value can
 * be typed straight away, and its built-in calendar button opens the native
 * calendar. `showPicker()` is attempted as a shortcut but cannot be relied on —
 * Obsidian rejects it with `NotAllowedError` ("requires a user gesture") even
 * from inside a genuine click handler.
 *
 * Deliberately *not* closed on blur. The editor reclaims focus right after the
 * field opens, and treating that as intent to dismiss made the field vanish
 * before it could be used. It closes on Enter (keep), Escape (revert) or a
 * click elsewhere (keep).
 *
 * Each `change` is written into the note straight away but leaves the field
 * open: Chromium can fire `change` for every segment typed into a
 * `datetime-local` field, and closing on it ended typing after one digit.
 */
function openDateTimePicker(opts: DateTimePickerOptions): void {
  // Never leave a second field behind if one is somehow still open.
  openPicker?.close();
  document.querySelectorAll(`.${PICKER_CLASS}`).forEach(el => el.remove());

  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.className = PICKER_CLASS;
  input.value = opts.initial;
  input.style.left = `${opts.x}px`;
  input.style.top = `${opts.y + 12}px`;
  document.body.appendChild(input);

  let closed = false;
  const finish = (reason: PickerCloseReason): void => {
    if (closed) return;
    closed = true;
    if (openPicker === handle) openPicker = null;
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    input.remove();
    opts.onClose(reason);
  };
  const pick = (): void => {
    if (input.value) opts.onPick(input.value);
  };
  const handle = {
    commit: (): void => {
      pick();
      finish('commit');
    },
    cancel: (): void => finish('cancel'),
    close: (): void => finish('outside'),
  };
  openPicker = handle;
  function onOutsidePointerDown(event: PointerEvent): void {
    if (event.target !== input) handle.close();
  }

  input.addEventListener('change', pick);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    // Without this the key's default action reaches the editor, which gets
    // focus back as the field closes: Enter split the Meta line or replaced a
    // selection in it (#85).
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') handle.commit();
    else handle.cancel();
  });
  // Armed a tick later so the very click that opened the field cannot close it.
  window.setTimeout(() => {
    if (!closed) document.addEventListener('pointerdown', onOutsidePointerDown, true);
  }, 0);

  // Also a tick later: focusing now loses to the editor, which takes focus
  // back once the click that opened the field has been handled (#85).
  window.setTimeout(() => {
    if (!closed) input.focus();
  }, 0);
  const withPicker = input as HTMLInputElement & { showPicker?: () => void };
  try {
    withPicker.showPicker?.();
  } catch {
    // Blocked by the host — the visible field remains fully usable on its own.
  }
}
