// What to put in the internal clipboard when copying from the editor.
// Mirrors Monaco's own ViewModel.getPlainTextToCopy() so the internal
// clipboard behaves exactly like the normal one:
//   * multiple cursors copy one chunk per cursor (and paste back per cursor);
//   * with nothing selected, copy/cut take the whole line, and pasting such a
//     line inserts it above the cursor line instead of mid-line.
// Kept free of Monaco imports so it can be unit-tested.

export interface RangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface TextModelLike {
  getEOL(): string;
  getValueInRange(range: RangeLike): string;
  getLineMaxColumn(lineNumber: number): number;
}

export interface ClipboardEntry {
  text: string;
  /** Copied with an empty selection (a whole line), so paste goes above the cursor line. */
  isFromEmptySelection: boolean;
  /** One chunk per cursor, used to distribute a multi-cursor paste. */
  multicursorText: string[] | null;
}

function isEmpty(range: RangeLike): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
}

function compareStarts(a: RangeLike, b: RangeLike): number {
  return a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn;
}

/** Returns null when there is nothing to copy. */
export function computeCopy(
  model: TextModelLike,
  selections: readonly RangeLike[],
  emptySelectionClipboard: boolean,
): ClipboardEntry | null {
  if (selections.length === 0) return null;
  const eol = model.getEOL();
  const ranges = [...selections].sort(compareStarts);
  const hasEmpty = ranges.some(isEmpty);
  const hasNonEmpty = ranges.some((range) => !isEmpty(range));
  if (!hasNonEmpty && !emptySelectionClipboard) return null;

  const chunks: string[] = [];
  if (hasEmpty && emptySelectionClipboard) {
    // Empty cursors contribute their whole line (once per line), selections their text.
    let previousLine = 0;
    for (const range of ranges) {
      if (isEmpty(range)) {
        if (range.startLineNumber !== previousLine) {
          const line = range.startLineNumber;
          chunks.push(
            model.getValueInRange({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }) + eol,
          );
        }
      } else {
        chunks.push(model.getValueInRange(range));
      }
      previousLine = range.startLineNumber;
    }
  } else {
    for (const range of ranges) if (!isEmpty(range)) chunks.push(model.getValueInRange(range));
  }

  return {
    text: chunks.join(chunks.length > 1 ? eol : ''),
    isFromEmptySelection: emptySelectionClipboard && selections.length === 1 && isEmpty(selections[0]),
    multicursorText: chunks.length > 1 ? chunks : null,
  };
}
