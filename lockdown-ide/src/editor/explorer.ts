// File explorer: a tree view of the virtual file system with create, rename
// and delete. Right-click is disabled app-wide, so every action is reachable
// from header buttons, per-row hover buttons, or the keyboard (F2 / Delete).

import { basename, dirname, FsError, joinPath, validateName, type EntryKind, type VirtualFileSystem } from './fileSystem';
import type { DocumentManager } from './documents';
import { showDialog } from '../ui/dialog';
import { fileIconClass } from '../ui/icons';

type EditState =
  | { mode: 'create'; kind: EntryKind; parent: string }
  | { mode: 'rename'; path: string };

interface Row {
  path: string;
  kind: EntryKind;
  depth: number;
}

export class FileExplorer {
  private readonly expanded = new Set<string>();
  private selected: string | null = null;
  private activeFile: string | null = null;
  private edit: EditState | null = null;
  private readonly tree: HTMLElement;
  private readonly openListeners = new Set<(path: string) => void>();

  constructor(
    root: HTMLElement,
    private readonly fs: VirtualFileSystem,
    private readonly docs: DocumentManager,
  ) {
    root.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">Explorer</span>
        <div class="pane-actions">
          <button type="button" class="icon-button codicon codicon-new-file" data-action="new-file" title="New File (Ctrl+N)" aria-label="New File"></button>
          <button type="button" class="icon-button codicon codicon-new-folder" data-action="new-folder" title="New Folder" aria-label="New Folder"></button>
          <button type="button" class="icon-button codicon codicon-collapse-all" data-action="collapse" title="Collapse Folders" aria-label="Collapse Folders"></button>
        </div>
      </div>
      <div class="tree" role="tree" tabindex="0" aria-label="Files"></div>`;
    this.tree = root.querySelector('.tree')!;

    root.querySelector('[data-action="new-file"]')!.addEventListener('click', () => this.startCreate('file'));
    root.querySelector('[data-action="new-folder"]')!.addEventListener('click', () => this.startCreate('directory'));
    root.querySelector('[data-action="collapse"]')!.addEventListener('click', () => {
      this.expanded.clear();
      this.render();
    });
    this.tree.addEventListener('keydown', (event) => this.onKeyDown(event));

    fs.onDidChange((event) => {
      if (event.type === 'rename') {
        // Keep folders expanded and the selection pointing at the moved item.
        for (const dir of [...this.expanded]) {
          if (dir === event.oldPath || dir.startsWith(`${event.oldPath}/`)) {
            this.expanded.delete(dir);
            this.expanded.add(event.newPath + dir.slice(event.oldPath.length));
          }
        }
        if (this.selected === event.oldPath) this.selected = event.newPath;
      }
      if (event.type === 'delete' && this.selected && !fs.exists(this.selected)) this.selected = null;
      this.render();
    });
    docs.onDidChangeDirty(() => this.render());
    this.render();
  }

  onOpen(listener: (path: string) => void): void {
    this.openListeners.add(listener);
  }

  /** Highlights the file shown in the editor and reveals it in the tree. */
  setActiveFile(path: string | null): void {
    this.activeFile = path;
    if (path) {
      this.selected = path;
      for (let dir = dirname(path); dir; dir = dirname(dir)) this.expanded.add(dir);
    }
    this.render();
  }

  /** Starts inline creation next to the current selection. */
  startCreate(kind: EntryKind): void {
    let parent = '';
    if (this.selected) parent = this.fs.isDirectory(this.selected) ? this.selected : dirname(this.selected);
    if (parent) this.expanded.add(parent);
    this.edit = { mode: 'create', kind, parent };
    this.render();
  }

  startRename(path: string): void {
    this.edit = { mode: 'rename', path };
    this.render();
  }

  async delete(path: string): Promise<void> {
    const isDir = this.fs.isDirectory(path);
    const unsaved = this.docs.dirtyPaths().filter((p) => p === path || p.startsWith(`${path}/`));
    const choice = await showDialog({
      title: isDir ? 'Delete folder' : 'Delete file',
      message:
        `Delete "${basename(path)}"${isDir ? ' and everything in it' : ''}? This cannot be undone.` +
        (unsaved.length ? ` ${unsaved.length} file(s) have unsaved changes.` : ''),
      buttons: [
        { id: 'delete', label: 'Delete', primary: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'delete') return;
    this.fs.delete(path);
    this.tree.focus();
  }

  private visibleRows(): Row[] {
    const rows: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of this.fs.readDirectory(dir)) {
        rows.push({ path: entry.path, kind: entry.kind, depth });
        if (entry.kind === 'directory' && this.expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return rows;
  }

  private render(): void {
    const rows = this.visibleRows();
    const fragment = document.createDocumentFragment();
    const edit = this.edit;

    // New entries appear at the top of their parent folder.
    const createDepth = edit?.mode === 'create' ? (edit.parent ? edit.parent.split('/').length : 0) : 0;
    if (edit?.mode === 'create' && edit.parent === '') fragment.append(this.editRow(edit.kind, createDepth, ''));

    for (const row of rows) {
      if (edit?.mode === 'rename' && edit.path === row.path) {
        fragment.append(this.editRow(row.kind, row.depth, basename(row.path)));
      } else {
        fragment.append(this.rowElement(row));
      }
      if (edit?.mode === 'create' && edit.parent === row.path) fragment.append(this.editRow(edit.kind, createDepth, ''));
    }

    if (rows.length === 0 && !edit) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'The workspace is empty. Use the buttons above to create a file.';
      fragment.append(empty);
    }

    this.tree.replaceChildren(fragment);
    const input = this.tree.querySelector<HTMLInputElement>('.tree-input');
    if (input) {
      input.focus();
      // Select the name without the extension, like VS Code.
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }
  }

  private rowElement(row: Row): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tree-row';
    el.setAttribute('role', 'treeitem');
    el.dataset.path = row.path;
    el.style.paddingLeft = `${8 + row.depth * 12}px`;
    el.classList.toggle('selected', row.path === this.selected);
    el.classList.toggle('active', row.path === this.activeFile);
    el.title = row.path;

    const twistie = document.createElement('span');
    const icon = document.createElement('span');
    if (row.kind === 'directory') {
      const open = this.expanded.has(row.path);
      el.setAttribute('aria-expanded', String(open));
      twistie.className = `twistie codicon codicon-chevron-${open ? 'down' : 'right'}`;
      icon.className = `file-icon codicon codicon-${open ? 'folder-opened' : 'folder'} icon-folder`;
    } else {
      twistie.className = 'twistie';
      icon.className = fileIconClass(row.path);
    }
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = basename(row.path);
    el.append(twistie, icon, label);

    if (row.kind === 'file' && this.docs.isDirty(row.path)) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      dot.title = 'Unsaved changes';
      el.append(dot);
    }

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    for (const [action, codicon, title] of [
      ['rename', 'edit', 'Rename (F2)'],
      ['delete', 'trash', 'Delete (Del)'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `icon-button codicon codicon-${codicon}`;
      button.title = title;
      button.setAttribute('aria-label', `${title.split(' ')[0]} ${basename(row.path)}`);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (action === 'rename') this.startRename(row.path);
        else void this.delete(row.path);
      });
      actions.append(button);
    }
    el.append(actions);

    el.addEventListener('click', () => {
      this.selected = row.path;
      if (row.kind === 'directory') this.toggle(row.path);
      else this.open(row.path);
    });
    return el;
  }

  private editRow(kind: EntryKind, depth: number, initial: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tree-row editing';
    el.style.paddingLeft = `${8 + depth * 12}px`;
    const twistie = document.createElement('span');
    twistie.className = 'twistie';
    const icon = document.createElement('span');
    icon.className = kind === 'directory' ? 'file-icon codicon codicon-folder icon-folder' : 'file-icon codicon codicon-file icon-file';
    const wrap = document.createElement('div');
    wrap.className = 'tree-input-wrap';
    const input = document.createElement('input');
    input.className = 'tree-input';
    input.value = initial;
    input.spellcheck = false;
    input.setAttribute('aria-label', kind === 'directory' ? 'Folder name' : 'File name');
    const message = document.createElement('div');
    message.className = 'tree-input-error';
    message.hidden = true;
    wrap.append(input, message);
    el.append(twistie, icon, wrap);

    let done = false;
    const showError = (text: string | null) => {
      message.textContent = text ?? '';
      message.hidden = !text;
      input.classList.toggle('invalid', !!text);
    };
    const finish = (commit: boolean) => {
      if (done) return;
      done = true; // set first: applying the edit re-renders the tree and may blur the input
      const name = input.value;
      if (commit && name !== initial && name.trim() !== '') {
        const error = validateName(name) ?? this.applyEdit(name);
        if (error) {
          done = false;
          showError(error);
          input.focus();
          return;
        }
      }
      this.edit = null;
      this.render();
      // Keep focus in the explorer unless the edit opened a file in the editor.
      if (document.activeElement === document.body) this.tree.focus();
    };

    input.addEventListener('input', () => showError(input.value ? validateName(input.value) : null));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => {
      // Blur commits a valid name and silently drops an invalid one.
      if (done) return;
      const name = input.value;
      if (name.trim() === '' || name === initial || validateName(name)) finish(false);
      else finish(true);
    });
    return el;
  }

  /** Applies the pending create/rename; returns an error message on failure. */
  private applyEdit(name: string): string | null {
    const edit = this.edit;
    if (!edit) return null;
    // Clear first so the re-render triggered by the file-system event drops the input row.
    this.edit = null;
    try {
      if (edit.mode === 'rename') {
        this.selected = this.fs.rename(edit.path, joinPath(dirname(edit.path), name));
      } else if (edit.kind === 'directory') {
        const path = this.fs.createDirectory(joinPath(edit.parent, name));
        this.expanded.add(path);
        this.selected = path;
      } else {
        const path = this.fs.createFile(joinPath(edit.parent, name));
        this.selected = path;
        this.open(path);
      }
      return null;
    } catch (error) {
      this.edit = edit;
      return error instanceof FsError ? error.message : String(error);
    }
  }

  private toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.render();
  }

  private open(path: string): void {
    for (const listener of this.openListeners) listener(path);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.edit) return;
    const rows = this.visibleRows();
    const index = rows.findIndex((row) => row.path === this.selected);
    const current = rows[index];
    const select = (row: Row | undefined) => {
      if (!row) return;
      this.selected = row.path;
      this.render();
      this.tree.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'ArrowDown':
        select(rows[index + 1] ?? rows[0]);
        break;
      case 'ArrowUp':
        select(rows[index - 1] ?? rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (current?.kind === 'directory' && !this.expanded.has(current.path)) this.toggle(current.path);
        break;
      case 'ArrowLeft':
        if (current?.kind === 'directory' && this.expanded.has(current.path)) this.toggle(current.path);
        else if (current) select(rows.find((row) => row.path === dirname(current.path)));
        break;
      case 'Enter':
        if (current?.kind === 'directory') this.toggle(current.path);
        else if (current) this.open(current.path);
        break;
      case 'F2':
        if (current) this.startRename(current.path);
        break;
      case 'Delete':
        if (current) void this.delete(current.path);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
