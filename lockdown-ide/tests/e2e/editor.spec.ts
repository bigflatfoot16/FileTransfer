import { expect, focusEditor, hooks, MOD, nativePress, test } from './fixtures';

test.describe('editor, tabs and explorer', () => {
  test('starts with the starter workspace', async ({ page }) => {
    const ide = hooks(page);
    expect(await ide.files()).toEqual(['index.html', 'script.js', 'style.css']);
    expect(await ide.openPaths()).toEqual(['index.html']);
    await expect(page.locator('.tree-row')).toHaveText(['index.html', 'script.js', 'style.css']);
    await expect(page.locator('.statusbar')).toContainText('HTML');
    await expect(page.locator('.titlebar-title')).toHaveText('index.html — Lockdown IDE');
  });

  test('Ctrl+S saves the active file (handled internally, no save dialog)', async ({ app, page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('<!-- edited -->');
    expect(await ide.isDirty('index.html')).toBe(true);
    await expect(page.locator('.tab.active')).toHaveClass(/dirty/);

    await nativePress(app, 'S', [MOD]);
    await expect.poll(() => ide.isDirty('index.html')).toBe(false);
    await expect(page.locator('.tab.active')).not.toHaveClass(/dirty/);
    await expect(page.locator('.status-notice')).toContainText('Saved index.html');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('undoing back to the saved text clears the unsaved marker', async ({ page }) => {
    const ide = hooks(page);
    await focusEditor(page);
    await page.keyboard.type('x');
    expect(await ide.isDirty('index.html')).toBe(true);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => ide.isDirty('index.html')).toBe(false);
  });

  test('clicking files opens tabs; tabs switch and close', async ({ app, page }) => {
    const ide = hooks(page);
    await page.locator('.tree-row', { hasText: 'script.js' }).click();
    await expect.poll(() => ide.activePath()).toBe('script.js');
    await page.locator('.tree-row', { hasText: 'style.css' }).click();
    expect(await ide.openPaths()).toEqual(['index.html', 'script.js', 'style.css']);
    await expect(page.locator('.statusbar')).toContainText('CSS');

    await page.locator('.tab', { hasText: 'index.html' }).click();
    await expect.poll(() => ide.activePath()).toBe('index.html');

    await nativePress(app, 'Tab', ['control']);
    await expect.poll(() => ide.activePath()).toBe('script.js');

    await nativePress(app, 'W', [MOD]);
    await expect.poll(() => ide.openPaths()).toEqual(['index.html', 'style.css']);
  });

  test('closing a tab with unsaved changes asks first', async ({ app, page }) => {
    const ide = hooks(page);
    await page.locator('.tree-row', { hasText: 'script.js' }).click();
    const original = await ide.value('script.js');
    await focusEditor(page);
    await page.keyboard.type('// scratch');

    await nativePress(app, 'W', [MOD]);
    const dialog = page.locator('.dialog');
    await expect(dialog).toContainText('save the changes you made to script.js');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await ide.openPaths()).toContain('script.js');

    await nativePress(app, 'W', [MOD]);
    await dialog.getByRole('button', { name: "Don't Save" }).click();
    await expect.poll(() => ide.openPaths()).toEqual(['index.html']);
    expect(await ide.value('script.js')).toBe(original);
  });

  test('creating a Python file gives Python highlighting and completions', async ({ page }) => {
    const ide = hooks(page);
    await page.locator('[data-action="new-file"]').click();
    await page.keyboard.type('main.py');
    await page.keyboard.press('Enter');
    await expect.poll(() => ide.activePath()).toBe('main.py');
    await expect(page.locator('.statusbar')).toContainText('Python');

    await page.keyboard.type('pri');
    await page.keyboard.press('Control+Space');
    await expect(page.locator('.suggest-widget')).toContainText('print');
  });

  test('JavaScript gets IntelliSense from the TypeScript service', async ({ page }) => {
    await page.locator('.tree-row', { hasText: 'script.js' }).click();
    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('document.getElementBy');
    await page.keyboard.press('Control+Space');
    await expect(page.locator('.suggest-widget')).toContainText('getElementById');
  });

  test('files and folders can be created, renamed and deleted', async ({ page }) => {
    const ide = hooks(page);
    await page.locator('[data-action="new-folder"]').click();
    await page.keyboard.type('css');
    await page.keyboard.press('Enter');

    // Move style.css into the folder by renaming it.
    await page.locator('.tree-row', { hasText: 'style.css' }).hover();
    await page.locator('.tree-row', { hasText: 'style.css' }).getByRole('button', { name: /Rename/ }).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('theme.css');
    await page.keyboard.press('Enter');
    await expect.poll(() => ide.files()).toContain('theme.css');

    // Invalid names are rejected inline.
    await page.locator('[data-action="new-file"]').click();
    await page.keyboard.type('bad?name');
    await expect(page.locator('.tree-input-error')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('.tree-row', { hasText: 'theme.css' }).hover();
    await page.locator('.tree-row', { hasText: 'theme.css' }).getByRole('button', { name: /Delete/ }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => ide.files()).toEqual(['index.html', 'script.js']);
  });

  test('toolbar toggles and shortcuts hide and show the panes', async ({ app, page }) => {
    await page.locator('[data-toggle="preview"]').click();
    await expect(page.locator('#preview')).toBeHidden();
    await page.locator('[data-toggle="console"]').click();
    await expect(page.locator('#console')).toBeHidden();
    await page.locator('[data-toggle="sidebar"]').click();
    await expect(page.locator('#sidebar')).toBeHidden();

    await nativePress(app, 'B', [MOD]);
    await expect(page.locator('#sidebar')).toBeVisible();
    await nativePress(app, '`', ['control']);
    await expect(page.locator('#console')).toBeVisible();
    await nativePress(app, 'V', [MOD, 'shift']);
    await expect(page.locator('#preview')).toBeVisible();
    await nativePress(app, 'V', [MOD, 'shift']);
    await expect(page.locator('#preview')).toBeHidden();
    // Run brings the preview back.
    await page.locator('[data-command="run"]').click();
    await expect(page.locator('#preview')).toBeVisible();
  });
});
