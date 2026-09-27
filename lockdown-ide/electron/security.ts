// SECURITY: process-wide hardening for sessions and web contents. Everything
// here is enforced by the main process, so it holds even if renderer-side
// JavaScript is bypassed.

import type { BrowserWindow, Session, WebContents } from 'electron';
import { APP_SCHEME, IPC, PREVIEW_SCHEME } from '../shared/ipc';
import { classifyKey } from './shortcuts';

export interface SecurityContext {
  /** Vite dev server URL, only set in development. */
  devServerUrl?: string;
  /** DevTools are allowed only in development with LOCKDOWN_DEVTOOLS=1. */
  allowDevTools: boolean;
  log(message: string): void;
  /** The preview iframe itself (not a frame nested in it) tried to leave the preview scheme. */
  onPreviewNavigationBlocked(url: string): void;
}

export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** Content-Security-Policy for the IDE's own document. */
export function appContentSecurityPolicy(devServerUrl?: string): string {
  const connect = ["'self'"];
  if (devServerUrl) connect.push(`ws://${new URL(devServerUrl).host}`); // Vite HMR socket
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    // Monaco (and Vite in dev) inject <style> elements at runtime.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `worker-src 'self' blob:`,
    `connect-src ${connect.join(' ')}`,
    // The only thing the IDE may frame is the preview protocol.
    `frame-src ${PREVIEW_SCHEME}:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/**
 * Is this URL the IDE's own document? (Compares scheme + host: for custom
 * schemes like lockdown:// the WHATWG `URL.origin` is always "null".)
 */
export function isAppUrl(url: string, ctx: SecurityContext): boolean {
  try {
    const parsed = new URL(url);
    if (ctx.devServerUrl) return parsed.origin === new URL(ctx.devServerUrl).origin;
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === 'app';
  } catch {
    return false;
  }
}

/** Is a network request allowed at all? Everything off-box is refused. */
function isAllowedRequest(url: string, ctx: SecurityContext): boolean {
  const scheme = url.slice(0, url.indexOf(':') + 1);
  switch (scheme) {
    case `${APP_SCHEME}:`:
    case `${PREVIEW_SCHEME}:`:
    case 'data:':
    case 'blob:':
      return true;
    case 'devtools:':
      return ctx.allowDevTools;
    case 'http:':
    case 'ws:':
      if (!ctx.devServerUrl) return false;
      return new URL(url).host === new URL(ctx.devServerUrl).host;
    default:
      // https:, wss:, file:, ftp:, chrome:, ... are never needed.
      return false;
  }
}

export function hardenSession(ses: Session, ctx: SecurityContext): void {
  // Deny every permission: clipboard-read/-write, media, screen capture,
  // notifications, geolocation, HID/USB/serial, ...
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    ctx.log(`Denied permission request: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // getDisplayMedia() (in-page screen capture): calling back with no streams rejects it.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));

  // No downloads: blocks e.g. user code saving its own source via a Blob link.
  ses.on('will-download', (event, item) => {
    ctx.log(`Blocked download: ${item.getFilename()}`);
    event.preventDefault();
  });

  ses.setSpellCheckerEnabled(false); // the spellchecker downloads dictionaries

  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequest(details.url, ctx);
    if (!allowed) ctx.log(`Blocked request: ${details.url}`);
    callback({ cancel: !allowed });
  });

  // In development the page comes from the Vite server, so attach the CSP as
  // a response header here. (In production the lockdown:// handler sets it.)
  if (ctx.devServerUrl) {
    const csp = appContentSecurityPolicy(ctx.devServerUrl);
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame' && isAppUrl(details.url, ctx)) {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      } else {
        callback({});
      }
    });
  }
}

export function hardenWebContents(contents: WebContents, ctx: SecurityContext): void {
  // Top-level navigation may never leave the app.
  contents.on('will-navigate', (event) => {
    if (!isAppUrl(event.url, ctx)) {
      ctx.log(`Blocked navigation: ${event.url}`);
      event.preventDefault();
    }
  });

  // Sub-frames (the preview iframe and anything user code nests inside it)
  // may only show workspace files.
  const isAllowedFrameUrl = (url: string) =>
    url.startsWith(`${PREVIEW_SCHEME}:`) || url === 'about:blank' || url === 'about:srcdoc';
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || isAllowedFrameUrl(event.url)) return; // main frame: see will-navigate
    ctx.log(`Blocked frame navigation: ${event.url}`);
    event.preventDefault();
  });
  // Electron does not emit will-frame-navigate for navigations started from
  // inside the sandboxed (opaque-origin) preview, e.g. `location.href = …`.
  // Those requests are still cancelled by the network filter above; here we
  // notice them so the renderer can put the preview back.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame || event.isSameDocument || isAllowedFrameUrl(event.url)) return;
    ctx.log(`Blocked frame navigation: ${event.url}`);
    if (event.frame?.parent === contents.mainFrame) ctx.onPreviewNavigationBlocked(event.url);
  });

  // No popups, no new windows, no <webview>.
  contents.setWindowOpenHandler(({ url }) => {
    ctx.log(`Blocked window.open: ${url}`);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());

  // Belt and braces: if DevTools somehow open while not allowed, close them.
  contents.on('devtools-opened', () => {
    if (!ctx.allowDevTools) contents.closeDevTools();
  });
}

/**
 * Keyboard policy for the main window. `before-input-event` runs before the
 * page (and the preview iframe) sees the key, so DevTools shortcuts are dead
 * everywhere and app shortcuts work regardless of focus.
 */
export function installInputGuard(win: BrowserWindow, ctx: SecurityContext): void {
  win.webContents.on('before-input-event', (event, input) => {
    const decision = classifyKey(input, process.platform);
    if (!decision) return;
    event.preventDefault();
    switch (decision.action) {
      case 'devtools':
        if (ctx.allowDevTools) win.webContents.toggleDevTools();
        else ctx.log(`Blocked DevTools shortcut: ${describeInput(input)}`);
        break;
      case 'block':
        break;
      case 'command':
        if (!input.isAutoRepeat) win.webContents.send(IPC.command, decision.command);
        break;
    }
  });
}

function describeInput(input: Electron.Input): string {
  const mods = [input.control && 'Ctrl', input.meta && 'Meta', input.alt && 'Alt', input.shift && 'Shift'].filter(Boolean);
  return [...mods, input.key].join('+');
}
