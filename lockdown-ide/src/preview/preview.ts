// Live preview. The workspace (including unsaved edits) is published to the
// main process, which serves it under lockdown-preview://workspace/ to a
// sandboxed iframe. Relative links between files (<link href="style.css">,
// <script src="script.js">, ES module imports, fetch('data.json')) resolve
// naturally against that origin.

import { PREVIEW_ORIGIN, type LockdownBridge } from '../../shared/ipc';
import type { ConsoleLevel, ConsolePanel } from '../console/console';
import type { DocumentManager } from '../editor/documents';
import { extname } from '../editor/fileSystem';

const REFRESH_DEBOUNCE_MS = 500;
const CONSOLE_LEVELS: ReadonlySet<string> = new Set(['log', 'info', 'warn', 'error', 'debug']);

function isHtml(path: string): boolean {
  const ext = extname(path);
  return ext === 'html' || ext === 'htm';
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class PreviewPane {
  private readonly iframe: HTMLIFrameElement;
  private readonly entryLabel: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly closeListeners = new Set<() => void>();
  private entry = 'index.html';
  private visible = true;
  private stale = false;
  private timer: number | undefined;
  private generation = 0;

  constructor(
    root: HTMLElement,
    private readonly bridge: LockdownBridge,
    private readonly docs: DocumentManager,
    private readonly consolePanel: ConsolePanel,
    private readonly notify: (message: string) => void,
  ) {
    root.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">Preview</span>
        <span class="preview-entry"></span>
        <div class="pane-actions">
          <button type="button" class="icon-button codicon codicon-refresh" data-action="reload" title="Reload Preview (F5)" aria-label="Reload Preview"></button>
          <button type="button" class="icon-button codicon codicon-close" data-action="close" title="Hide Preview (Ctrl+Shift+V)" aria-label="Hide Preview"></button>
        </div>
      </div>
      <div class="preview-body">
        <div class="preview-placeholder" hidden></div>
      </div>`;
    this.entryLabel = root.querySelector('.preview-entry')!;
    this.placeholder = root.querySelector('.preview-placeholder')!;

    // SECURITY: the preview iframe.
    //  * sandbox="allow-scripts" only: opaque origin (no access to the IDE,
    //    its storage or the preload bridge), no popups, no top navigation,
    //    no forms, no modal dialogs, no downloads.
    //  * allow="…'none'": Permissions Policy denies clipboard and capture APIs.
    //  * The server adds a strict CSP with no network access (previewContent.ts).
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'preview-frame';
    this.iframe.title = 'Preview';
    this.iframe.setAttribute('sandbox', 'allow-scripts');
    this.iframe.setAttribute(
      'allow',
      "clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; camera 'none'; microphone 'none'; geolocation 'none'",
    );
    this.iframe.referrerPolicy = 'no-referrer';
    root.querySelector('.preview-body')!.append(this.iframe);

    root.querySelector('[data-action="reload"]')!.addEventListener('click', () => void this.refreshNow('Preview reloaded'));
    root.querySelector('[data-action="close"]')!.addEventListener('click', () => {
      for (const listener of this.closeListeners) listener();
    });

    window.addEventListener('message', (event) => this.onMessage(event));
    docs.onDidChangeContent(() => this.scheduleRefresh());
    bridge.preview.onNavigationBlocked((url) => {
      // The main process stopped the frame from leaving the workspace; reload the page it left.
      void this.refreshNow('Preview restored').then(() =>
        this.consolePanel.log('warn', `Navigation to ${url} was blocked: the preview cannot open external pages.`),
      );
    });
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Follows the active editor: switching to another HTML file previews that page. */
  setActiveFile(path: string | null): void {
    if (path && isHtml(path) && path !== this.entry) {
      this.entry = path;
      void this.refreshNow('Preview switched to ' + path);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.stale) void this.refreshNow('Preview updated');
  }

  /** Debounced refresh used while typing. */
  scheduleRefresh(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refreshNow('Preview updated'), REFRESH_DEBOUNCE_MS);
  }

  async refreshNow(reason: string): Promise<void> {
    window.clearTimeout(this.timer);
    if (!this.visible) {
      this.stale = true; // don't run user code in a hidden pane
      return;
    }
    this.stale = false;

    const files = this.docs.workingCopies();
    if (!(this.entry in files)) {
      this.entry = Object.keys(files).filter(isHtml).sort()[0] ?? 'index.html';
    }
    const generation = ++this.generation;
    if (!(this.entry in files)) {
      this.showPlaceholder('No HTML file to preview. Create an index.html to get started.');
      return;
    }

    try {
      await this.bridge.preview.publish({ files });
    } catch (error) {
      this.consolePanel.log('error', `Preview failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (generation !== this.generation) return; // superseded by a newer refresh

    this.consolePanel.reset(reason);
    this.placeholder.hidden = true;
    this.iframe.hidden = false;
    this.entryLabel.textContent = this.entry;
    // A fresh query string forces a full reload of the page and its assets.
    this.iframe.src = `${PREVIEW_ORIGIN}/${encodePath(this.entry)}?v=${generation}`;
  }

  private showPlaceholder(message: string): void {
    this.entryLabel.textContent = '';
    this.placeholder.textContent = message;
    this.placeholder.hidden = false;
    this.iframe.hidden = true;
    this.iframe.removeAttribute('src');
  }

  private onMessage(event: MessageEvent): void {
    // Only trust messages from our own preview frame (its origin is "null"
    // because of the sandbox, so identity is checked by window reference).
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data as { source?: unknown; type?: unknown; level?: unknown; message?: unknown; action?: unknown };
    if (!data || data.source !== 'lockdown-preview') return;
    switch (data.type) {
      case 'console':
        if (typeof data.level === 'string' && CONSOLE_LEVELS.has(data.level) && typeof data.message === 'string') {
          this.consolePanel.log(data.level as ConsoleLevel, data.message);
        }
        break;
      case 'clear':
        this.consolePanel.clear();
        break;
      case 'blocked':
        if (typeof data.action === 'string') this.notify(`${data.action[0].toUpperCase()}${data.action.slice(1)} is disabled inside the preview.`);
        break;
    }
  }
}
