// SECURITY: internal-only clipboard.
//
// Copy, cut and paste keep working everywhere in the IDE (the editor, the
// find widget, inputs, the console), but the text only ever lives in this
// in-memory buffer:
//
//  * Every copy/cut/paste event is intercepted at the window in the capture
//    phase, before any other listener (Monaco included) sees it, and its
//    default action is cancelled.
//  * The event's clipboardData is never given any text, so nothing typed in
//    the IDE reaches the OS clipboard. On copy we write only an opaque marker
//    type, which lets a later paste tell "last copy happened in the IDE"
//    apart from "something was copied in another app".
//  * The OS clipboard's contents are never read or inserted, so text copied
//    in another application (e.g. AI output) cannot be pasted in.
//
// The main process adds a second layer (electron/clipboardGuard.ts) and the
// preview iframe has its own block (electron/previewShim.ts).

import { monaco } from '../editor/monaco';
import { computeCopy, type ClipboardEntry } from './copyText';

/** Opaque marker written on copy. Carries no content. */
export const CLIPBOARD_MARKER_TYPE = 'application/x-lockdown-ide';

/** InputEvent types that move text through the OS clipboard or drag-and-drop. */
const BLOCKED_INPUT_TYPES = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertFromYank',
  'deleteByCut',
  'deleteByDrag',
]);

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTextField(element: Element | null): element is TextField {
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && ['text', 'search', 'url', 'email', 'tel', 'number', ''].includes(element.type);
}

export class InternalClipboard {
  private entry: ClipboardEntry | null = null;
  private readonly editors = new Set<monaco.editor.ICodeEditor>();

  constructor(private readonly notify: (message: string) => void) {}

  /** Text currently held by the internal clipboard (for tests and diagnostics). */
  get text(): string | null {
    return this.entry?.text ?? null;
  }

  registerEditor(editor: monaco.editor.ICodeEditor): void {
    this.editors.add(editor);
    editor.onDidDispose(() => this.editors.delete(editor));
  }

  install(target: Window = window): void {
    const onClipboardEvent = (event: ClipboardEvent) => {
      // SECURITY: cancel the browser's own clipboard handling and stop the
      // event here so no other code can write to or read from clipboardData.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'paste') {
        this.paste(event);
      } else {
        this.copy(event.type === 'cut');
        // Only a content-free marker goes to the OS clipboard (see above).
        event.clipboardData?.setData(CLIPBOARD_MARKER_TYPE, '1');
      }
    };
    target.addEventListener('copy', onClipboardEvent, true);
    target.addEventListener('cut', onClipboardEvent, true);
    target.addEventListener('paste', onClipboardEvent, true);

    // Defence in depth: refuse any text insertion or deletion that is routed
    // through the clipboard or drag-and-drop without a clipboard event.
    target.addEventListener(
      'beforeinput',
      (event) => {
        if (BLOCKED_INPUT_TYPES.has(event.inputType)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  private focusedEditor(): monaco.editor.ICodeEditor | undefined {
    for (const editor of this.editors) if (editor.hasTextFocus()) return editor;
    return undefined;
  }

  private copy(isCut: boolean): void {
    const editor = this.focusedEditor();
    if (editor) {
      this.copyFromEditor(editor, isCut);
      return;
    }
    const active = document.activeElement;
    if (isTextField(active)) {
      this.copyFromField(active, isCut);
      return;
    }
    // Plain page text, e.g. a line in the console panel.
    const text = window.getSelection()?.toString() ?? '';
    if (text) this.entry = { text, isFromEmptySelection: false, multicursorText: null };
  }

  private copyFromEditor(editor: monaco.editor.ICodeEditor, isCut: boolean): void {
    const model = editor.getModel();
    if (!model) return;
    const entry = computeCopy(
      model,
      editor.getSelections() ?? [],
      editor.getOption(monaco.editor.EditorOption.emptySelectionClipboard),
    );
    if (!entry) return;
    this.entry = entry;
    if (isCut && !editor.getOption(monaco.editor.EditorOption.readOnly)) {
      // Monaco's own cut command: deletes the selection (or the whole line
      // when nothing is selected) as a single undoable edit.
      editor.trigger('keyboard', 'cut', null);
    }
  }

  private copyFromField(field: TextField, isCut: boolean): void {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    if (start === end) return;
    this.entry = { text: field.value.slice(start, end), isFromEmptySelection: false, multicursorText: null };
    if (isCut && !field.readOnly && !field.disabled) {
      // execCommand keeps the field's native undo stack intact.
      if (!document.execCommand('delete')) field.setRangeText('', start, end, 'end');
    }
  }

  private paste(event: ClipboardEvent): void {
    // Anything on the OS clipboard without our marker was copied outside the
    // IDE. Only the list of types is inspected; the content is never read.
    const types = event.clipboardData ? [...event.clipboardData.types] : [];
    if (types.length > 0 && !types.includes(CLIPBOARD_MARKER_TYPE)) {
      this.notify('Pasting content copied outside Lockdown IDE is blocked.');
      return;
    }
    const entry = this.entry;
    if (!entry) {
      this.notify('Nothing to paste. The clipboard only holds text copied inside Lockdown IDE.');
      return;
    }

    const editor = this.focusedEditor();
    if (editor) {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      // Monaco's own paste command: handles multi-cursor distribution,
      // whole-line paste, auto-indent and undo stops.
      editor.trigger('keyboard', 'paste', {
        text: entry.text,
        pasteOnNewLine: entry.isFromEmptySelection && editor.getOption(monaco.editor.EditorOption.emptySelectionClipboard),
        multicursorText: entry.multicursorText,
      });
      return;
    }
    const active = document.activeElement;
    if (isTextField(active) && !active.readOnly && !active.disabled) {
      if (!document.execCommand('insertText', false, entry.text)) {
        active.setRangeText(entry.text, active.selectionStart ?? 0, active.selectionEnd ?? 0, 'end');
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
}
