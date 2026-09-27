// Renderer entry point: builds the workbench and wires the pieces together.

import './styles/main.css';
import type { AppCommand, LockdownBridge } from '../shared/ipc';
import { InternalClipboard } from './clipboard/clipboard';
import { ConsolePanel } from './console/console';
import { DocumentManager } from './editor/documents';
import { FileExplorer } from './editor/explorer';
import { basename, VirtualFileSystem } from './editor/fileSystem';
import { languageForPath, languageLabel } from './editor/languages';
import { createEditor, initMonaco } from './editor/monaco';
import { STARTER_FILES } from './editor/starterFiles';
import { TabManager } from './editor/tabs';
import { Layout, type Part } from './layout/layout';
import { StatusBar } from './layout/statusbar';
import { TitleBar, type TitleBarCommand } from './layout/titlebar';
import { PreviewPane } from './preview/preview';
import { installLockdown } from './security/lockdown';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function boot(bridge: LockdownBridge): void {
  const statusbar = new StatusBar(byId('statusbar'));
  const warn = (message: string) => statusbar.notify(message, 'warning');

  // SECURITY: install the lockdowns and the internal clipboard before any
  // content exists, so there is never a window where the OS clipboard is live.
  installLockdown(warn);
  const clipboard = new InternalClipboard(warn);
  clipboard.install(window);

  // Workspace + editor.
  const fs = new VirtualFileSystem(STARTER_FILES);
  initMonaco();
  const editor = createEditor(byId('editor'));
  clipboard.registerEditor(editor);
  const docs = new DocumentManager(fs);
  const tabs = new TabManager(byId('tabs'), byId('editor'), byId('editor-empty'), editor, docs);
  const explorer = new FileExplorer(byId('sidebar'), fs, docs);

  // Output.
  const consolePanel = new ConsolePanel(byId('console'));
  const preview = new PreviewPane(byId('preview'), bridge, docs, consolePanel, warn);
  bridge.preview.onLog((entry) => consolePanel.log(entry.message.startsWith('[security]') ? 'system' : entry.level, entry.message));

  // Chrome.
  const layout = new Layout({
    workbench: byId('workbench'),
    sidebar: byId('sidebar'),
    editorRow: byId('editor-row'),
    preview: byId('preview'),
    mainArea: byId('main-area'),
    console: byId('console'),
    sashes: {
      sidebar: document.querySelector<HTMLElement>('[data-sash="sidebar"]')!,
      preview: document.querySelector<HTMLElement>('[data-sash="preview"]')!,
      console: document.querySelector<HTMLElement>('[data-sash="console"]')!,
    },
  });

  const save = () => {
    const path = tabs.activePath;
    if (!path) return;
    docs.save(path);
    statusbar.notify(`Saved ${basename(path)}`);
  };
  const saveAll = () => {
    const saved = docs.saveAll();
    statusbar.notify(saved.length ? `Saved ${saved.length} file${saved.length === 1 ? '' : 's'}` : 'All files are saved');
  };
  const run = () => {
    layout.setVisible('preview', true);
    void preview.refreshNow('Preview reloaded');
  };

  const titlebar = new TitleBar(
    byId('titlebar'),
    bridge.platform,
    (command: TitleBarCommand) => {
      switch (command) {
        case 'new-file':
          layout.setVisible('sidebar', true);
          explorer.startCreate('file');
          break;
        case 'new-folder':
          layout.setVisible('sidebar', true);
          explorer.startCreate('directory');
          break;
        case 'save':
          save();
          break;
        case 'save-all':
          saveAll();
          break;
        case 'run':
          run();
          break;
        case 'exit':
          bridge.window.control('close');
          break;
      }
    },
    (part) => layout.toggle(part),
    (action) => bridge.window.control(action),
  );
  bridge.window.onMaximizedChange((maximized) => titlebar.setMaximized(maximized));

  const syncToggles = (part: Part, visible: boolean) => {
    titlebar.setToggleState(part, visible);
    if (part === 'preview') preview.setVisible(visible);
  };
  for (const part of ['sidebar', 'preview', 'console'] as const) syncToggles(part, layout.isVisible(part));
  layout.onDidChangeVisibility(syncToggles);
  preview.onClose(() => layout.setVisible('preview', false));
  consolePanel.onClose(() => layout.setVisible('console', false));

  // Keep title, explorer highlight, status bar and preview in sync with the active tab.
  const refreshTitle = () => {
    const path = tabs.activePath;
    titlebar.setTitle(path ? `${docs.isDirty(path) ? '● ' : ''}${basename(path)} — Lockdown IDE` : 'Lockdown IDE');
  };
  tabs.onDidChangeActive((path) => {
    refreshTitle();
    explorer.setActiveFile(path);
    preview.setActiveFile(path);
    const position = editor.getPosition();
    if (path && position) {
      statusbar.setLanguage(languageLabel(languageForPath(path)));
      statusbar.setCursor(position.lineNumber, position.column, 0);
    } else {
      statusbar.clearEditorInfo();
    }
  });
  docs.onDidChangeDirty(refreshTitle);
  explorer.onOpen((path) => tabs.open(path));
  editor.onDidChangeCursorSelection((event) => {
    const model = editor.getModel();
    const selected = model ? model.getValueLengthInRange(event.selection) : 0;
    statusbar.setCursor(event.selection.positionLineNumber, event.selection.positionColumn, selected);
  });

  // App shortcuts arrive from the main process (see electron/shortcuts.ts),
  // so they work even while the preview iframe has focus.
  const commands: Record<AppCommand, () => void> = {
    save,
    'save-all': saveAll,
    run,
    'new-file': () => {
      layout.setVisible('sidebar', true);
      explorer.startCreate('file');
    },
    'close-tab': () => {
      if (tabs.activePath) void tabs.close(tabs.activePath);
    },
    'next-tab': () => tabs.next(1),
    'prev-tab': () => tabs.next(-1),
    'toggle-sidebar': () => layout.toggle('sidebar'),
    'toggle-preview': () => layout.toggle('preview'),
    'toggle-console': () => layout.toggle('console'),
  };
  bridge.onCommand((command) => commands[command]?.());

  // Files live in memory only: ask before the window closes with unsaved work
  // (the main process shows the confirmation dialog).
  window.addEventListener('beforeunload', (event) => {
    if (docs.dirtyPaths().length > 0) event.preventDefault();
  });

  tabs.open('index.html');
  void preview.refreshNow('Preview loaded');

  // Read-only hooks for the end-to-end tests; compiled out of normal builds.
  if (import.meta.env.MODE === 'e2e') {
    Object.assign(window, {
      __lockdownE2E: {
        value: (path: string) => docs.getModel(path)?.getValue(),
        setValue: (path: string, text: string) => docs.getModel(path)?.setValue(text),
        activePath: () => tabs.activePath,
        openPaths: () => [...tabs.openPaths],
        isDirty: (path: string) => docs.isDirty(path),
        files: () => fs.listFiles(),
        internalClipboard: () => clipboard.text,
        /** Each range is [startLine, startColumn, endLine, endColumn]. */
        setSelections: (ranges: Array<[number, number, number, number]>) =>
          editor.setSelections(
            ranges.map(([startLine, startCol, endLine, endCol]) => ({
              selectionStartLineNumber: startLine,
              selectionStartColumn: startCol,
              positionLineNumber: endLine,
              positionColumn: endCol,
            })),
          ),
      },
    });
  }
}

const bridge = window.lockdown;
if (bridge) {
  boot(bridge);
} else {
  // SECURITY: outside the Electron shell (e.g. the dev-server URL opened in a
  // normal browser) none of the protections apply, so refuse to run.
  document.getElementById('app')?.remove();
  document.getElementById('shell-required')!.hidden = false;
}
