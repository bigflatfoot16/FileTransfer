// Shared fixtures for the end-to-end tests: launches the built Electron app
// and exposes helpers to inspect the *real* OS clipboard from the main process.

import { test as base, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Read-only hooks the renderer exposes in `--mode e2e` builds (see src/main.ts). */
interface E2EHooks {
  value(path: string): string | undefined;
  setValue(path: string, text: string): void;
  activePath(): string | null;
  openPaths(): string[];
  isDirty(path: string): boolean;
  files(): string[];
  internalClipboard(): string | null;
  setSelections(ranges: Array<[number, number, number, number]>): void;
}

declare global {
  interface Window {
    __lockdownE2E: E2EHooks;
  }
}

export const test = base.extend<{ app: ElectronApplication; page: Page }>({
  app: async ({}, use) => {
    // Chromium's OS sandbox can't start as root (CI containers) or without the
    // SUID helper on Linux; the per-window sandbox still applies.
    const args = process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'];
    // A fresh profile per test, so persisted UI state (e.g. hidden panes) never leaks between tests.
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'lockdown-ide-e2e-'));
    const app = await electron.launch({ args, cwd: projectRoot, env: { ...process.env, LOCKDOWN_USER_DATA_DIR: userDataDir } });
    await use(app);
    // destroy() skips the unsaved-changes prompt so teardown never hangs.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => undefined);
    await app.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__lockdownE2E?.activePath() === 'index.html');
    await page.locator('.monaco-editor .view-lines').first().waitFor();
    await page.frameLocator('iframe.preview-frame').locator('h1').waitFor();
    await use(page);
  },
});

export { expect } from '@playwright/test';

export function hooks(page: Page) {
  return {
    value: (file: string) => page.evaluate((f) => window.__lockdownE2E.value(f) ?? '', file),
    setValue: (file: string, text: string) => page.evaluate(([f, t]) => window.__lockdownE2E.setValue(f, t), [file, text] as const),
    activePath: () => page.evaluate(() => window.__lockdownE2E.activePath()),
    openPaths: () => page.evaluate(() => window.__lockdownE2E.openPaths()),
    isDirty: (file: string) => page.evaluate((f) => window.__lockdownE2E.isDirty(f), file),
    files: () => page.evaluate(() => window.__lockdownE2E.files()),
    internalClipboard: () => page.evaluate(() => window.__lockdownE2E.internalClipboard()),
    setSelections: (ranges: Array<[number, number, number, number]>) =>
      page.evaluate((r) => window.__lockdownE2E.setSelections(r), ranges),
  };
}

/** Writes plain text to the real OS clipboard (as another app would). */
export async function setOsClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/**
 * Everything textual on the real OS clipboard: the distinct contents of all
 * formats, joined. (X11 exposes the same text under several format names.)
 */
export async function readOsClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ clipboard }) => {
    const parts = new Set<string>();
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        const data: unknown = await item.getType(type).catch(() => null);
        if (data && typeof (data as Blob).text === 'function') parts.add(await (data as Blob).text());
      }
    }
    parts.delete('');
    return [...parts].join('\n');
  });
}

/** Simulates the window gaining focus and waits for the guard to record its baseline. */
export async function emitWindowEvent(app: ElectronApplication, event: 'focus' | 'blur'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, e) => {
    BrowserWindow.getAllWindows()[0].emit(e);
  }, event);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

type Modifier = 'control' | 'meta' | 'shift' | 'alt';
/** Cmd on macOS, Ctrl elsewhere. */
export const MOD: Modifier = process.platform === 'darwin' ? 'meta' : 'control';

/**
 * Presses a key through Electron's real input pipeline. Playwright's own
 * keyboard (CDP) bypasses `before-input-event`, where the main process
 * handles app shortcuts and blocks DevTools, so use this for those keys.
 */
export async function nativePress(app: ElectronApplication, keyCode: string, modifiers: Modifier[] = []): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [key, mods]) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
    },
    [keyCode, modifiers] as const,
  );
}

/** Clicks into the editor so it has keyboard focus. */
export async function focusEditor(page: Page): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click();
}

/** 1-based [line, column] of the first occurrence of `needle` in `text`. */
export function positionOf(text: string, needle: string): [number, number] {
  const lines = text.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  if (line === -1) throw new Error(`"${needle}" not found`);
  return [line + 1, lines[line].indexOf(needle) + 1];
}

/** Selects the first occurrence of `needle` in the active editor. */
export async function select(page: Page, file: string, needle: string): Promise<void> {
  const [line, column] = positionOf(await hooks(page).value(file), needle);
  await hooks(page).setSelections([[line, column, line, column + needle.length]]);
}

export const consoleOutput = (page: Page) => page.locator('.console-output');
export const statusNotice = (page: Page) => page.locator('.status-notice');
export const preview = (page: Page) => page.frameLocator('iframe.preview-frame');
