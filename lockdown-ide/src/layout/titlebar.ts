// Custom title bar (the window is frameless): app menu, toolbar, title and
// window controls. The empty areas are the window's drag region.

import type { WindowControl } from '../../shared/ipc';
import type { Part } from './layout';

export type TitleBarCommand = 'new-file' | 'new-folder' | 'save' | 'save-all' | 'exit' | 'run';

export class TitleBar {
  private readonly title: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement | null;

  constructor(
    root: HTMLElement,
    platform: string,
    private readonly onCommand: (command: TitleBarCommand) => void,
    private readonly onToggle: (part: Part) => void,
    onWindowControl: (action: WindowControl) => void,
  ) {
    const isMac = platform === 'darwin';
    const mod = isMac ? '⌘' : 'Ctrl+';
    root.classList.toggle('mac', isMac);
    root.innerHTML = `
      <div class="titlebar-left">
        <span class="app-icon codicon codicon-lock" title="Lockdown IDE"></span>
        <div class="menu">
          <button type="button" class="menu-button" aria-haspopup="true" aria-expanded="false">File</button>
          <div class="menu-dropdown" role="menu" hidden>
            <button type="button" role="menuitem" data-command="new-file"><span>New File</span><kbd>${mod}N</kbd></button>
            <button type="button" role="menuitem" data-command="new-folder"><span>New Folder</span><kbd></kbd></button>
            <div class="menu-separator"></div>
            <button type="button" role="menuitem" data-command="save"><span>Save</span><kbd>${mod}S</kbd></button>
            <button type="button" role="menuitem" data-command="save-all"><span>Save All</span><kbd>${mod}${isMac ? '⇧' : 'Shift+'}S</kbd></button>
            <div class="menu-separator"></div>
            <button type="button" role="menuitem" data-command="exit"><span>Exit</span><kbd></kbd></button>
          </div>
        </div>
        <div class="toolbar">
          <button type="button" class="tool-button run-button" data-command="run" title="Run: reload the preview (F5)">
            <span class="codicon codicon-play"></span><span>Run</span>
          </button>
          <button type="button" class="tool-button toggle" data-toggle="sidebar" title="Toggle Sidebar (${mod}B)" aria-label="Toggle Sidebar">
            <span class="codicon codicon-layout-sidebar-left"></span>
          </button>
          <button type="button" class="tool-button toggle" data-toggle="preview" title="Toggle Preview (${mod}${isMac ? '⇧' : 'Shift+'}V)" aria-label="Toggle Preview">
            <span class="codicon codicon-open-preview"></span><span>Preview</span>
          </button>
          <button type="button" class="tool-button toggle" data-toggle="console" title="Toggle Console (Ctrl+\`)" aria-label="Toggle Console">
            <span class="codicon codicon-layout-panel"></span><span>Console</span>
          </button>
        </div>
      </div>
      <div class="titlebar-title"></div>
      ${
        isMac
          ? ''
          : `<div class="window-controls">
              <button type="button" class="window-control codicon codicon-chrome-minimize" data-window="minimize" title="Minimize" aria-label="Minimize"></button>
              <button type="button" class="window-control codicon codicon-chrome-maximize" data-window="toggle-maximize" title="Maximize" aria-label="Maximize"></button>
              <button type="button" class="window-control close codicon codicon-chrome-close" data-window="close" title="Close" aria-label="Close"></button>
            </div>`
      }`;

    this.title = root.querySelector('.titlebar-title')!;
    this.menu = root.querySelector('.menu-dropdown')!;
    this.menuButton = root.querySelector('.menu-button')!;
    this.maximizeButton = root.querySelector('[data-window="toggle-maximize"]');

    this.menuButton.addEventListener('click', () => this.setMenuOpen(this.menu.hasAttribute('hidden')));
    for (const item of root.querySelectorAll<HTMLElement>('[data-command]')) {
      item.addEventListener('click', () => {
        this.setMenuOpen(false);
        this.onCommand(item.dataset.command as TitleBarCommand);
      });
    }
    for (const button of root.querySelectorAll<HTMLElement>('[data-toggle]')) {
      button.addEventListener('click', () => this.onToggle(button.dataset.toggle as Part));
    }
    for (const button of root.querySelectorAll<HTMLElement>('[data-window]')) {
      button.addEventListener('click', () => onWindowControl(button.dataset.window as WindowControl));
    }
    // Close the menu on outside click or Escape.
    document.addEventListener('mousedown', (event) => {
      if (!this.menu.hasAttribute('hidden') && !(event.target as Element).closest('.menu')) this.setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.menu.hasAttribute('hidden')) this.setMenuOpen(false);
    });
    root.addEventListener('dblclick', (event) => {
      // Double-clicking the empty title bar maximizes, like a native frame.
      if (!isMac && (event.target as Element) === root) onWindowControl('toggle-maximize');
    });
  }

  setTitle(text: string): void {
    this.title.textContent = text;
    document.title = text;
  }

  setToggleState(part: Part, active: boolean): void {
    const button = this.menuButton.ownerDocument.querySelector<HTMLElement>(`[data-toggle="${part}"]`);
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', String(active));
  }

  setMaximized(maximized: boolean): void {
    if (!this.maximizeButton) return;
    this.maximizeButton.classList.toggle('codicon-chrome-maximize', !maximized);
    this.maximizeButton.classList.toggle('codicon-chrome-restore', maximized);
    this.maximizeButton.title = maximized ? 'Restore' : 'Maximize';
  }

  private setMenuOpen(open: boolean): void {
    this.menu.hidden = !open;
    this.menuButton.setAttribute('aria-expanded', String(open));
    if (open) this.menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
}
