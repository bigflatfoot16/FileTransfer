// Editor tabs: one tab per open file, a single Monaco editor instance whose
// model is swapped when the active tab changes (view state is kept per tab).

import type { monaco } from './monaco';
import type { DocumentManager } from './documents';
import { basename, dirname } from './fileSystem';
import { showDialog } from '../ui/dialog';
import { fileIconClass } from '../ui/icons';

export class TabManager {
  private tabs: string[] = [];
  private active: string | null = null;
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private readonly activeListeners = new Set<(path: string | null) => void>();

  constructor(
    private readonly strip: HTMLElement,
    private readonly editorHost: HTMLElement,
    private readonly emptyState: HTMLElement,
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly docs: DocumentManager,
  ) {
    docs.onDidChangeDirty(() => this.render());
    docs.onDidRename((moves) => this.onRename(moves));
    docs.onDidDelete((paths) => this.onDelete(paths));

    strip.addEventListener('wheel', (event) => {
      // Vertical wheel scrolls the tab strip horizontally, like VS Code.
      if (event.deltaY !== 0) strip.scrollLeft += event.deltaY;
    }, { passive: true });

    this.render();
  }

  get activePath(): string | null {
    return this.active;
  }

  get openPaths(): readonly string[] {
    return this.tabs;
  }

  onDidChangeActive(listener: (path: string | null) => void): void {
    this.activeListeners.add(listener);
  }

  open(path: string, focus = true): void {
    if (!this.docs.getModel(path)) return;
    if (!this.tabs.includes(path)) {
      // Open next to the active tab.
      const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(at, 0, path);
    }
    this.activate(path);
    if (focus) this.editor.focus();
  }

  /** Closes a tab, asking what to do with unsaved changes. Resolves false if cancelled. */
  async close(path: string): Promise<boolean> {
    if (!this.tabs.includes(path)) return true;
    if (this.docs.isDirty(path)) {
      const choice = await showDialog({
        title: 'Unsaved changes',
        message: `Do you want to save the changes you made to ${basename(path)}?`,
        buttons: [
          { id: 'save', label: 'Save', primary: true },
          { id: 'discard', label: "Don't Save" },
          { id: 'cancel', label: 'Cancel' },
        ],
        cancelId: 'cancel',
      });
      if (choice === 'cancel') return false;
      if (choice === 'save') this.docs.save(path);
      else this.docs.revert(path);
    }
    this.remove(path);
    return true;
  }

  next(direction: 1 | -1): void {
    if (this.tabs.length < 2 || !this.active) return;
    const index = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(index + direction + this.tabs.length) % this.tabs.length]);
    this.editor.focus();
  }

  private activate(path: string | null): void {
    if (this.active && this.active !== path && this.docs.getModel(this.active)) {
      this.viewStates.set(this.active, this.editor.saveViewState());
    }
    this.active = path;
    const model = path ? this.docs.getModel(path) ?? null : null;
    if (this.editor.getModel() !== model) {
      this.editor.setModel(model);
      const state = path ? this.viewStates.get(path) : null;
      if (state) this.editor.restoreViewState(state);
    }
    this.editorHost.hidden = !model;
    this.emptyState.hidden = !!model;
    this.render();
    for (const listener of this.activeListeners) listener(path);
  }

  private remove(path: string): void {
    const index = this.tabs.indexOf(path);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    this.viewStates.delete(path);
    if (this.active === path) {
      this.active = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] ?? null);
    } else {
      this.render();
    }
  }

  private onRename(moves: Array<[string, string]>): void {
    let activeMoved: string | null = null;
    for (const [from, to] of moves) {
      const index = this.tabs.indexOf(from);
      if (index !== -1) this.tabs[index] = to;
      if (this.viewStates.has(from)) {
        this.viewStates.set(to, this.viewStates.get(from)!);
        this.viewStates.delete(from);
      }
      if (this.active === from) activeMoved = to;
    }
    if (activeMoved) {
      // The old model was disposed; attach the re-created one.
      this.active = null;
      this.activate(activeMoved);
    } else {
      this.render();
    }
  }

  private onDelete(paths: string[]): void {
    for (const path of paths) this.remove(path);
  }

  render(): void {
    this.strip.replaceChildren();
    // Show the folder next to the name when two open files share a name.
    const nameCounts = new Map<string, number>();
    for (const path of this.tabs) nameCounts.set(basename(path), (nameCounts.get(basename(path)) ?? 0) + 1);

    for (const path of this.tabs) {
      const dirty = this.docs.isDirty(path);
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.classList.toggle('active', path === this.active);
      tab.classList.toggle('dirty', dirty);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(path === this.active));
      tab.dataset.path = path;
      tab.title = path + (dirty ? ' (unsaved)' : '');

      const icon = document.createElement('span');
      icon.className = fileIconClass(path);
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = basename(path);
      tab.append(icon, label);
      if ((nameCounts.get(basename(path)) ?? 0) > 1 && dirname(path)) {
        const hint = document.createElement('span');
        hint.className = 'tab-hint';
        hint.textContent = dirname(path);
        tab.append(hint);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close codicon codicon-close';
      close.title = 'Close (Ctrl+W)';
      close.setAttribute('aria-label', `Close ${basename(path)}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.close(path);
      });
      tab.append(close);

      tab.addEventListener('mousedown', (event) => {
        if (event.button === 0 && !(event.target as Element).closest('.tab-close')) {
          this.activate(path);
          // Focus after the click completes so the editor keeps it.
          requestAnimationFrame(() => this.editor.focus());
        }
      });
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) void this.close(path); // middle-click closes
      });
      this.strip.append(tab);
    }
    this.strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
