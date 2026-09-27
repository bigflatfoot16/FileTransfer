import { consoleOutput, expect, MOD, nativePress, preview, test } from './fixtures';

test.describe('security lockdowns', () => {
  test('the renderer has no Node.js and only the narrow preload bridge', async ({ page }) => {
    const result = await page.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>).require,
      process: typeof (window as unknown as Record<string, unknown>).process,
      module: typeof (window as unknown as Record<string, unknown>).module,
      bridge: Object.keys((window as unknown as { lockdown?: object }).lockdown ?? {}).sort(),
    }));
    expect(result).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      bridge: ['onCommand', 'platform', 'preview', 'window'],
    });
  });

  test('DevTools cannot be opened, by shortcut or programmatically', async ({ app, page }) => {
    // Through the real input pipeline (blocked by the main process)…
    await nativePress(app, 'F12');
    for (const key of ['I', 'J', 'C']) await nativePress(app, key, [MOD, 'shift']);
    // …and as synthesized DOM key events (blocked by the renderer).
    for (const combo of ['F12', 'Control+Shift+I', 'Control+Shift+J', 'Control+Shift+C']) {
      await page.keyboard.press(combo);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.openDevTools());
    await page.waitForTimeout(500);
    const opened = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened());
    expect(opened).toBe(false);
    await expect(consoleOutput(page)).toContainText('Blocked DevTools shortcut: F12');
    await expect(consoleOutput(page)).toContainText('Blocked DevTools shortcut: Ctrl+Shift+I');
  });

  test('content protection is on', async ({ app }) => {
    test.skip(process.platform === 'linux', 'setContentProtection is only supported on Windows and macOS');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isContentProtected())).toBe(true);
  });

  test('the window cannot navigate away or open new windows', async ({ app, page }) => {
    await page.evaluate(() => {
      window.open('https://example.com/');
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe('lockdown://app/index.html');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('the IDE document enforces a strict Content-Security-Policy', async ({ page }) => {
    const result = await page.evaluate(
      () =>
        new Promise<{ inlineRan: boolean; violation: string }>((resolve) => {
          let violation = '';
          document.addEventListener('securitypolicyviolation', (e) => (violation = e.effectiveDirective), { once: true });
          const script = document.createElement('script');
          script.textContent = 'window.__inlineRan = true';
          document.head.append(script);
          setTimeout(() => resolve({ inlineRan: '__inlineRan' in window, violation }), 200);
        }),
    );
    expect(result).toEqual({ inlineRan: false, violation: 'script-src-elem' });
  });

  test('permissions such as clipboard access are denied', async ({ page }) => {
    const states = await page.evaluate(async () => {
      const query = (name: string) =>
        navigator.permissions.query({ name: name as PermissionName }).then((s) => s.state, () => 'unsupported');
      return [await query('clipboard-read'), await query('clipboard-write')];
    });
    expect(states).toEqual(['denied', 'denied']);
  });

  test('the preview is sandboxed: opaque origin, no access to the IDE, no bridge', async ({ page }) => {
    const body = preview(page).locator('body');
    const result = await body.evaluate(() => {
      let parentAccess = 'allowed';
      try {
        void (window.parent as Window).document.title;
      } catch {
        parentAccess = 'blocked';
      }
      return {
        origin: window.origin,
        parentAccess,
        bridge: typeof (window as unknown as { lockdown?: unknown }).lockdown,
        storage: (() => {
          try {
            return typeof localStorage;
          } catch {
            return 'blocked';
          }
        })(),
      };
    });
    expect(result).toEqual({ origin: 'null', parentAccess: 'blocked', bridge: 'undefined', storage: 'blocked' });
  });

  test('the preview has no network access', async ({ page }) => {
    const outcome = await preview(page)
      .locator('body')
      .evaluate(() => fetch('https://example.com/').then(() => 'reached', () => 'blocked'));
    expect(outcome).toBe('blocked');
  });

  test('the preview cannot navigate away', async ({ page }) => {
    await preview(page)
      .locator('body')
      .evaluate(() => {
        location.href = 'https://example.com/';
      });
    // The request is refused and the preview is put back on the workspace page.
    await expect(consoleOutput(page)).toContainText('Navigation to https://example.com/ was blocked');
    await expect(preview(page).locator('h1')).toHaveText('Hello, Lockdown IDE!');
    const frameUrl = page.frames().find((f) => f !== page.mainFrame())?.url();
    expect(frameUrl).toMatch(/^lockdown-preview:\/\/workspace\/index\.html/);
  });

  test('printing is disabled', async ({ page }) => {
    await page.evaluate(() => window.print());
    await expect(page.locator('.status-notice')).toContainText('Printing is disabled');
  });
});
