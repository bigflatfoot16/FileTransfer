// The internal clipboard is the IDE's most important protection, so these
// tests check the REAL OS clipboard (read from the main process) after every
// operation: nothing typed in the IDE may ever show up there, and nothing put
// there by another app may ever be pasted in.

import {
  consoleOutput,
  emitWindowEvent,
  expect,
  focusEditor,
  hooks,
  positionOf,
  preview,
  readOsClipboard,
  select,
  setOsClipboard,
  statusNotice,
  test,
} from './fixtures';

const H1 = '<h1>Hello, Lockdown IDE!</h1>';
const SECRET_MARKER = 'Hello, Lockdown';

test.describe('internal clipboard', () => {
  test('copy and paste work inside the editor and never reach the OS clipboard', async ({ app, page }) => {
    const ide = hooks(page);
    await setOsClipboard(app, 'OS-SENTINEL');
    await focusEditor(page);
    await select(page, 'index.html', H1);

    await page.keyboard.press('ControlOrMeta+C');
    expect(await ide.internalClipboard()).toBe(H1);
    expect(await readOsClipboard(app)).not.toContain(SECRET_MARKER);

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ControlOrMeta+V');
    const after = await ide.value('index.html');
    expect(after.endsWith(H1)).toBe(true);
    expect(after.split(H1)).toHaveLength(3); // original + pasted copy
    expect(await readOsClipboard(app)).not.toContain(SECRET_MARKER);
  });

  test('Ctrl+Insert / Shift+Insert (alternative shortcuts) are internal too', async ({ app, page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    await select(page, 'index.html', H1);
    await page.keyboard.press('Control+Insert');
    expect(await ide.internalClipboard()).toBe(H1);
    expect(await readOsClipboard(app)).not.toContain(SECRET_MARKER);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Shift+Insert');
    expect((await ide.value('index.html')).endsWith(H1)).toBe(true);
  });

  test('cut removes the selection into the internal clipboard only', async ({ app, page }) => {
    const ide = hooks(page);
    await setOsClipboard(app, 'OS-SENTINEL');
    await focusEditor(page);
    await select(page, 'index.html', 'Clicked 0 times');

    await page.keyboard.press('ControlOrMeta+X');
    expect(await ide.value('index.html')).not.toContain('Clicked 0 times');
    expect(await ide.internalClipboard()).toBe('Clicked 0 times');
    expect(await readOsClipboard(app)).not.toContain('Clicked 0 times');

    await page.keyboard.press('ControlOrMeta+V');
    expect(await ide.value('index.html')).toContain('>Clicked 0 times</button>');
  });

  test('with no selection, copy takes the whole line and paste inserts it above', async ({ page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    const before = await ide.value('index.html');
    const [titleLine] = positionOf(before, '<title>');
    await ide.setSelections([[titleLine, 3, titleLine, 3]]);
    await page.keyboard.press('ControlOrMeta+C');
    expect(await ide.internalClipboard()).toBe('  <title>My Page</title>\n');

    // Paste in the middle of line 1: the line goes above line 1, not mid-line.
    await ide.setSelections([[1, 5, 1, 5]]);
    await page.keyboard.press('ControlOrMeta+V');
    const lines = (await ide.value('index.html')).split('\n');
    expect(lines[0]).toBe('  <title>My Page</title>');
    expect(lines[1]).toBe('<!DOCTYPE html>');
  });

  test('multi-cursor copy pastes one chunk per cursor', async ({ page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    const text = await ide.value('index.html');
    const [headOpen, headOpenCol] = positionOf(text, '<head>');
    const [headClose, headCloseCol] = positionOf(text, '</head>');
    await ide.setSelections([
      [headOpen, headOpenCol, headOpen, headOpenCol + '<head>'.length],
      [headClose, headCloseCol, headClose, headCloseCol + '</head>'.length],
    ]);
    await page.keyboard.press('ControlOrMeta+C');
    expect(await ide.internalClipboard()).toBe('<head>\n</head>');

    // Two cursors at the end of lines 1 and 2: each receives its own chunk.
    const lines = text.split('\n');
    await ide.setSelections([
      [1, lines[0].length + 1, 1, lines[0].length + 1],
      [2, lines[1].length + 1, 2, lines[1].length + 1],
    ]);
    await page.keyboard.press('ControlOrMeta+V');
    const after = (await ide.value('index.html')).split('\n');
    expect(after[0]).toBe(`${lines[0]}<head>`);
    expect(after[1]).toBe(`${lines[1]}</head>`);
  });

  test('text copied in another application cannot be pasted in', async ({ app, page }) => {
    const ide = hooks(page);
    await setOsClipboard(app, 'EXTERNAL AI ANSWER');
    await focusEditor(page);
    const before = await ide.value('index.html');

    await page.keyboard.press('ControlOrMeta+V');
    await expect(statusNotice(page)).toContainText('outside Lockdown IDE is blocked');
    expect(await ide.value('index.html')).toBe(before);

    // Even with something in the internal clipboard, a newer external copy is refused…
    await select(page, 'index.html', 'My Page');
    await page.keyboard.press('ControlOrMeta+C');
    await setOsClipboard(app, 'EXTERNAL AI ANSWER');
    await page.keyboard.press('ControlOrMeta+V');
    expect(await ide.value('index.html')).toBe(before);
    expect(await ide.value('index.html')).not.toContain('EXTERNAL');

    // …and copying inside the IDE again makes paste work again.
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ControlOrMeta+V');
    expect((await ide.value('index.html')).endsWith('My Page')).toBe(true);
  });

  test('copy and paste also work in text inputs, internally', async ({ app, page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    await select(page, 'index.html', 'Page');
    await page.keyboard.press('ControlOrMeta+C');

    // Paste into the explorer's new-file name box.
    await page.locator('[data-action="new-file"]').click();
    const input = page.locator('.tree-input');
    await expect(input).toBeFocused();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(input).toHaveValue('Page');
    await page.keyboard.type('.js');

    // Copy from the input goes to the internal clipboard too.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    expect(await ide.internalClipboard()).toBe('Page.js');
    expect(await readOsClipboard(app)).not.toContain('Page.js');

    await page.keyboard.press('Enter');
    await expect.poll(() => ide.activePath()).toBe('Page.js');
  });

  test('navigator.clipboard is unavailable to the renderer', async ({ app, page }) => {
    await setOsClipboard(app, 'OS-SENTINEL');
    const results = await page.evaluate(async () => {
      const outcome = (p: Promise<unknown>) => p.then(() => 'allowed', (e: DOMException) => e.name);
      return {
        write: await outcome(navigator.clipboard.writeText('LEAKED')),
        read: await outcome(navigator.clipboard.readText()),
      };
    });
    expect(results).toEqual({ write: 'NotAllowedError', read: 'NotAllowedError' });
    expect(await readOsClipboard(app)).toBe('OS-SENTINEL');
  });

  test('copying inside the preview never reaches the OS clipboard', async ({ app, page }) => {
    await setOsClipboard(app, 'OS-SENTINEL');
    const frame = preview(page);
    await frame.locator('h1').click();
    await frame.locator('h1').evaluate((h1) => {
      const range = document.createRange();
      range.selectNodeContents(h1);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('ControlOrMeta+X');
    await expect(statusNotice(page)).toContainText('disabled inside the preview');
    expect(await readOsClipboard(app)).not.toContain(SECRET_MARKER);

    // Scripts in the preview have no clipboard API at all.
    const api = await frame.locator('body').evaluate(() => typeof navigator.clipboard);
    expect(api).toBe('undefined');
  });

  test('the main process clears the OS clipboard if it changed while the IDE was focused', async ({ app, page }) => {
    // Simulates a path the renderer can't see (e.g. a nested frame, a capture tool).
    await setOsClipboard(app, 'BEFORE');
    await emitWindowEvent(app, 'focus');
    await setOsClipboard(app, 'WRITTEN WHILE FOCUSED');
    await emitWindowEvent(app, 'blur');
    await expect.poll(() => readOsClipboard(app)).toBe('');
    await expect(consoleOutput(page)).toContainText('OS clipboard changed while Lockdown IDE was focused');
  });

  test('the guard leaves the OS clipboard alone if nothing changed', async ({ app }) => {
    await setOsClipboard(app, 'UNCHANGED');
    await emitWindowEvent(app, 'focus');
    await emitWindowEvent(app, 'blur');
    expect(await readOsClipboard(app)).toBe('UNCHANGED');
  });

  test('drag-and-drop out of and into the IDE is blocked', async ({ page }) => {
    const ide = hooks(page);
    const before = await ide.value('index.html');
    const result = await page.evaluate(() => {
      const dispatch = (target: Element, type: string, data?: string) => {
        const dataTransfer = new DataTransfer();
        if (data) dataTransfer.setData('text/plain', data);
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const editor = document.querySelector('.monaco-editor .view-lines')!;
      return {
        dragStartPrevented: dispatch(document.querySelector('.tree-row')!, 'dragstart'),
        dropPrevented: dispatch(editor, 'drop', 'DROPPED FROM OUTSIDE'),
      };
    });
    expect(result).toEqual({ dragStartPrevented: true, dropPrevented: true });
    expect(await ide.value('index.html')).toBe(before);
  });

  test('the right-click context menu is disabled', async ({ page }) => {
    await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' });
    await page.locator('.tree-row').first().click({ button: 'right' });
    // Monaco keeps an empty, hidden .context-view container; no menu may render in it.
    await expect(page.locator('.monaco-menu')).toHaveCount(0);
    await expect(page.locator('.context-view').filter({ visible: true })).toHaveCount(0);
    const prevented = await page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await expect(consoleOutput(page)).not.toContainText('Uncaught');
  });
});
