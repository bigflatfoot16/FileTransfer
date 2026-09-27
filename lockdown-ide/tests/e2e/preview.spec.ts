import { consoleOutput, expect, focusEditor, hooks, nativePress, preview, select, test } from './fixtures';

test.describe('live preview and console', () => {
  test('renders the workspace with its CSS and JS', async ({ page }) => {
    await expect(preview(page).locator('h1')).toHaveText('Hello, Lockdown IDE!');
    // style.css was loaded through a relative <link>.
    await expect(preview(page).locator('h1')).toHaveCSS('color', 'rgb(14, 99, 156)');
    await expect(consoleOutput(page)).toContainText('script.js loaded at');
  });

  test('reloads live while typing (unsaved edits included)', async ({ page }) => {
    await focusEditor(page);
    await select(page, 'index.html', 'Hello, Lockdown IDE!');
    await page.keyboard.type('Typed live');
    await expect(preview(page).locator('h1')).toHaveText('Typed live');
    expect(await hooks(page).isDirty('index.html')).toBe(true);
  });

  test('console.log output and interactions reach the console panel', async ({ page }) => {
    await preview(page).locator('#counter').click();
    await preview(page).locator('#counter').click();
    await expect(preview(page).locator('#counter')).toHaveText('Clicked 2 times');
    await expect(consoleOutput(page)).toContainText('Button clicked: 1');
    await expect(consoleOutput(page)).toContainText('Button clicked: 2');
  });

  test('errors, missing files and blocked network requests are reported', async ({ page }) => {
    await hooks(page).setValue(
      'index.html',
      `<!DOCTYPE html><html><head><link rel="stylesheet" href="missing.css"></head>
<body><img src="https://example.com/tracker.png">
<script>console.warn('careful', { a: [1, 2] }); undefinedFunction();</script></body></html>`,
    );
    await expect(consoleOutput(page)).toContainText(`careful {a: [1, 2]}`);
    await expect(consoleOutput(page)).toContainText('undefinedFunction is not defined');
    await expect(consoleOutput(page)).toContainText('404: "missing.css" does not exist in the workspace.');
    await expect(consoleOutput(page)).toContainText('Blocked by Lockdown IDE (img-src): https://example.com/tracker.png');
    await expect(page.locator('.console-badge')).toBeVisible();
  });

  test('modal dialogs and external links are redirected to the console', async ({ page }) => {
    await hooks(page).setValue(
      'index.html',
      `<a id="out" href="https://example.com">out</a><script>alert('hi there'); confirm('sure?');</script>`,
    );
    await expect(consoleOutput(page)).toContainText('alert: hi there');
    await expect(consoleOutput(page)).toContainText('confirm: sure?');
    await preview(page).locator('#out').click();
    await expect(consoleOutput(page)).toContainText('Navigation to https://example.com/ was blocked');
  });

  test('multi-page sites work and the preview follows the active HTML file', async ({ page }) => {
    const ide = hooks(page);
    await page.locator('[data-action="new-file"]').click();
    await page.keyboard.type('about.html');
    await page.keyboard.press('Enter');
    await expect.poll(() => ide.activePath()).toBe('about.html');
    await ide.setValue('about.html', '<h1>About page</h1><a id="home" href="index.html">home</a>');
    await expect(preview(page).locator('h1')).toHaveText('About page');
    await expect(page.locator('.preview-entry')).toHaveText('about.html');

    // Relative links between workspace pages navigate inside the preview.
    await preview(page).locator('#home').click();
    await expect(preview(page).locator('h1')).toHaveText('Hello, Lockdown IDE!');
  });

  test('Run (F5) reloads the preview and clears the console', async ({ app, page }) => {
    await preview(page).locator('#counter').click();
    await expect(consoleOutput(page)).toContainText('Button clicked: 1');
    await nativePress(app, 'F5');
    await expect(consoleOutput(page)).not.toContainText('Button clicked');
    await expect(consoleOutput(page)).toContainText('script.js loaded at');
    await expect(preview(page).locator('#counter')).toHaveText('Clicked 0 times');
  });
});
