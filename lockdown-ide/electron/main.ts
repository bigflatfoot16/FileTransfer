// Lockdown IDE: Electron main process.
//
// Responsibilities:
//   * create the single, hardened BrowserWindow
//   * serve the renderer (production) from the lockdown:// protocol
//   * serve the live-preview snapshot from the lockdown-preview:// protocol
//   * enforce the security policy (see security.ts and clipboardGuard.ts)

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEME, IPC, PREVIEW_SCHEME, type PreviewLogEntry, type WindowControl } from '../shared/ipc';
import { installClipboardGuard } from './clipboardGuard';
import { buildPreviewResponse, validateSnapshot } from './previewContent';
import {
  APP_ORIGIN,
  appContentSecurityPolicy,
  hardenSession,
  hardenWebContents,
  installInputGuard,
  isAppUrl,
  type SecurityContext,
} from './security';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(here, '../dist');

// SECURITY: the dev server URL is only honoured for unpackaged builds, so a
// packaged app cannot be pointed at an arbitrary page via an env variable.
const devServerUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
// SECURITY: DevTools are disabled in production. In development they stay
// disabled too unless explicitly requested with LOCKDOWN_DEVTOOLS=1.
const allowDevTools = Boolean(devServerUrl) && process.env.LOCKDOWN_DEVTOOLS === '1';

// SECURITY: a packaged build refuses to start with debugging switches, which
// would let another program attach to the app and read the code out of the
// editor. (Unpackaged dev/test runs need them. Environment-variable routes
// such as NODE_OPTIONS are closed with Electron Fuses at packaging time.)
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'];
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) {
  console.error('[lockdown] Refusing to start with debugging switches.');
  app.exit(1);
}

// Unpackaged builds only: an isolated profile directory (used by the E2E
// tests so every run starts from a clean slate).
if (!app.isPackaged && process.env.LOCKDOWN_USER_DATA_DIR) {
  app.setPath('userData', process.env.LOCKDOWN_USER_DATA_DIR);
}

let mainWindow: BrowserWindow | null = null;
let previewFiles: ReadonlyMap<string, string> = new Map();

const security: SecurityContext = {
  devServerUrl,
  allowDevTools,
  log: (message) => {
    console.log(`[lockdown] ${message}`);
    sendPreviewLog({ level: 'warn', message: `[security] ${message}` });
  },
  onPreviewNavigationBlocked: (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.previewNavigationBlocked, url);
  },
};

function sendPreviewLog(entry: PreviewLogEntry): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.previewLog, entry);
}

// Custom schemes must be registered before the app is ready. "standard" gives
// them real origins and relative-URL resolution; "secure" treats them like HTTPS.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// SECURITY: force the Chromium sandbox on for every renderer. An explicit
// --no-sandbox is respected because some Linux setups (no SUID helper,
// restricted user namespaces, root in CI containers) cannot start otherwise;
// the per-window `sandbox: true` below still keeps Node out of the renderer.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

const APP_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Serves the built renderer from dist/ as lockdown://app/…, never file://. */
function registerAppProtocol(): void {
  const csp = appContentSecurityPolicy();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(DIST_DIR, relative === '/' ? 'index.html' : relative));
    // Path traversal guard: only files inside dist/ are served.
    if (!filePath.startsWith(DIST_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = new Uint8Array(await readFile(filePath));
      const ext = path.extname(filePath).toLowerCase();
      const headers: Record<string, string> = {
        'Content-Type': APP_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      };
      if (ext === '.html') headers['Content-Security-Policy'] = csp;
      return new Response(body, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Serves the in-memory workspace snapshot to the sandboxed preview iframe. */
function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const response = buildPreviewResponse(previewFiles, request.url);
    if (response.missing) {
      sendPreviewLog({ level: 'error', message: `404: "${response.missing}" does not exist in the workspace.` });
    }
    return new Response(response.body, { status: response.status, headers: response.headers });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** SECURITY: only the IDE's own top-level document may use the IPC API. */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!mainWindow || !frame || frame !== mainWindow.webContents.mainFrame) return false;
  return isAppUrl(frame.url, security);
}

function registerIpc(): void {
  ipcMain.on(IPC.windowControl, (event, action: WindowControl) => {
    if (!isTrustedSender(event) || !mainWindow) return;
    switch (action) {
      case 'minimize':
        mainWindow.minimize();
        break;
      case 'toggle-maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        break;
      case 'close':
        mainWindow.close();
        break;
    }
  });

  ipcMain.handle(IPC.previewPublish, (event, snapshot: unknown) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted sender');
    previewFiles = validateSnapshot(snapshot);
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: 'Lockdown IDE',
    backgroundColor: '#1e1e1e',
    // Custom title bar drawn by the renderer. macOS keeps its traffic lights.
    ...(isMac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 10 } } : { frame: false }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      // SECURITY: the renderer gets no Node.js and runs in an isolated world
      // inside the Chromium sandbox. It can only use the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // SECURITY: DevTools are compiled out of the window unless allowed.
      devTools: allowDevTools,
    },
  });

  // SECURITY: exclude the window from screenshots and screen recordings
  // (Windows 10 2004+: omitted from captures; macOS: NSWindowSharingNone).
  // Not supported on Linux.
  win.setContentProtection(true);

  installInputGuard(win, security);
  installClipboardGuard(win, security.log);

  win.on('maximize', () => win.webContents.send(IPC.windowState, true));
  win.on('unmaximize', () => win.webContents.send(IPC.windowState, false));
  win.once('ready-to-show', () => win.show());

  // The renderer registers a beforeunload handler while files are unsaved.
  // Files only live in memory, so confirm before throwing them away.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Lockdown IDE keeps files in memory only. Closing the window discards the whole workspace.',
    });
    if (choice === 0) event.preventDefault(); // preventDefault = ignore beforeunload and close
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function installMenu(): void {
  if (process.platform !== 'darwin') {
    // Windows/Linux: no menu bar at all (File > Exit lives in the custom title bar).
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs Edit-menu roles for Cmd+C/X/V to reach the page. The roles
  // dispatch ordinary DOM copy/cut/paste events, which the renderer's internal
  // clipboard intercepts, so nothing reaches the OS clipboard.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Apply navigation/window-open guards to every web contents ever created.
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, security));

  app.whenReady().then(() => {
    hardenSession(session.defaultSession, security);
    registerAppProtocol();
    registerPreviewProtocol();
    registerIpc();
    installMenu();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (!mainWindow) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
