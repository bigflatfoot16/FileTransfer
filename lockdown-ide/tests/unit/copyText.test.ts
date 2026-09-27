import { describe, expect, it } from 'vitest';
import { computeCopy, type RangeLike, type TextModelLike } from '../../src/clipboard/copyText';

/** Minimal stand-in for a Monaco text model (1-based lines and columns). */
function model(text: string, eol = '\n'): TextModelLike {
  const lines = text.split('\n');
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + eol.length, 0) + column - 1;
  const joined = lines.join(eol);
  return {
    getEOL: () => eol,
    getLineMaxColumn: (line) => lines[line - 1].length + 1,
    getValueInRange: (r) => joined.slice(offset(r.startLineNumber, r.startColumn), offset(r.endLineNumber, r.endColumn)),
  };
}

const range = (sl: number, sc: number, el: number, ec: number): RangeLike => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec,
});
const cursor = (line: number, column: number) => range(line, column, line, column);

describe('computeCopy', () => {
  const doc = model('alpha beta\ngamma delta\nepsilon');

  it('copies a single selection', () => {
    expect(computeCopy(doc, [range(1, 1, 1, 6)], true)).toEqual({
      text: 'alpha',
      isFromEmptySelection: false,
      multicursorText: null,
    });
  });

  it('copies a selection spanning lines', () => {
    expect(computeCopy(doc, [range(1, 7, 2, 6)], true)?.text).toBe('beta\ngamma');
  });

  it('copies the whole line (with newline) for an empty selection', () => {
    expect(computeCopy(doc, [cursor(2, 3)], true)).toEqual({
      text: 'gamma delta\n',
      isFromEmptySelection: true,
      multicursorText: null,
    });
  });

  it('copies nothing for an empty selection when emptySelectionClipboard is off', () => {
    expect(computeCopy(doc, [cursor(2, 3)], false)).toBeNull();
  });

  it('keeps one chunk per cursor, in document order', () => {
    const entry = computeCopy(doc, [range(2, 1, 2, 6), range(1, 1, 1, 6)], true);
    expect(entry).toEqual({ text: 'alpha\ngamma', isFromEmptySelection: false, multicursorText: ['alpha', 'gamma'] });
  });

  it('copies each line only once for several empty cursors on the same line', () => {
    const entry = computeCopy(doc, [cursor(1, 2), cursor(1, 5), cursor(3, 1)], true);
    expect(entry?.multicursorText).toEqual(['alpha beta\n', 'epsilon\n']);
    expect(entry?.isFromEmptySelection).toBe(false); // only a single empty cursor pastes "on a new line"
  });

  it('mixes whole lines and selections like Monaco does', () => {
    const entry = computeCopy(doc, [cursor(1, 1), range(2, 1, 2, 6)], true);
    expect(entry?.multicursorText).toEqual(['alpha beta\n', 'gamma']);
  });

  it('ignores empty cursors when emptySelectionClipboard is off', () => {
    expect(computeCopy(doc, [cursor(1, 1), range(2, 1, 2, 6)], false)?.text).toBe('gamma');
  });

  it("uses the model's line ending", () => {
    const crlf = model('one\ntwo', '\r\n');
    expect(computeCopy(crlf, [cursor(1, 1)], true)?.text).toBe('one\r\n');
    expect(computeCopy(crlf, [range(1, 1, 2, 4)], true)?.text).toBe('one\r\ntwo');
  });

  it('returns null without selections', () => {
    expect(computeCopy(doc, [], true)).toBeNull();
  });
});
