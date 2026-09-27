// Virtual, in-memory file system. Nothing here ever touches the disk: there
// are no real paths a user could open in another program.
//
// Paths are workspace-relative and use "/" separators, e.g. "css/site.css".
// The root directory is "". This class holds the *saved* content of each
// file; unsaved edits live in the Monaco models (see documents.ts).

export type EntryKind = 'file' | 'directory';

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: EntryKind;
}

export type FsEvent =
  | { type: 'create'; path: string; kind: EntryKind }
  | { type: 'write'; path: string }
  /** `files` lists every file removed (for a directory, all descendants). */
  | { type: 'delete'; path: string; kind: EntryKind; files: string[] }
  /** `files` maps every moved file from its old to its new path. */
  | { type: 'rename'; oldPath: string; newPath: string; kind: EntryKind; files: Array<[string, string]> };

export class FsError extends Error {}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Returns an error message for an invalid file/folder name, or null if it is fine. */
export function validateName(name: string): string | null {
  if (name.trim() === '') return 'A name is required.';
  if (name !== name.trim()) return 'Names cannot start or end with whitespace.';
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`;
  if (/[/\\]/.test(name)) return 'Names cannot contain "/" or "\\".';
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return 'Names cannot contain control characters or any of < > : " | ? *';
  if (name.length > 255) return 'Names must be 255 characters or fewer.';
  return null;
}

/** Normalizes and validates a workspace path ("a//b/" → "a/b"). */
export function normalizePath(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    const error = validateName(segment);
    if (error) throw new FsError(`Invalid path "${path}": ${error}`);
  }
  return segments.join('/');
}

function isInside(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

export class VirtualFileSystem {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  private readonly listeners = new Set<(event: FsEvent) => void>();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      const normalized = normalizePath(path);
      this.ensureParents(normalized);
      this.files.set(normalized, content);
    }
  }

  onDidChange(listener: (event: FsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  isDirectory(path: string): boolean {
    return path === '' || this.dirs.has(path);
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isDirectory(path);
  }

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new FsError(`File not found: ${path}`);
    return content;
  }

  /** Writes a file, creating it (and its parent folders) if needed. */
  writeFile(path: string, content: string): void {
    const normalized = normalizePath(path);
    if (this.dirs.has(normalized)) throw new FsError(`"${normalized}" is a folder.`);
    const created = !this.files.has(normalized);
    if (created) this.ensureParents(normalized);
    this.files.set(normalized, content);
    this.emit(created ? { type: 'create', path: normalized, kind: 'file' } : { type: 'write', path: normalized });
  }

  createFile(path: string, content = ''): string {
    const normalized = normalizePath(path);
    if (this.exists(normalized)) throw new FsError(`"${normalized}" already exists.`);
    this.writeFile(normalized, content);
    return normalized;
  }

  createDirectory(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === '') throw new FsError('The workspace root already exists.');
    if (this.exists(normalized)) throw new FsError(`"${normalized}" already exists.`);
    this.ensureParents(normalized);
    this.dirs.add(normalized);
    this.emit({ type: 'create', path: normalized, kind: 'directory' });
    return normalized;
  }

  /** Renames or moves a file or folder (folders move with all their contents). */
  rename(oldPath: string, newPath: string): string {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (from === to) return to;
    if (!this.exists(from) || from === '') throw new FsError(`"${oldPath}" does not exist.`);
    if (this.exists(to)) throw new FsError(`"${to}" already exists.`);

    if (this.files.has(from)) {
      this.ensureParents(to);
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      this.emit({ type: 'rename', oldPath: from, newPath: to, kind: 'file', files: [[from, to]] });
      return to;
    }

    if (isInside(to, from)) throw new FsError('A folder cannot be moved into itself.');
    this.ensureParents(to);
    const moved: Array<[string, string]> = [];
    for (const path of [...this.files.keys()]) {
      if (isInside(path, from)) {
        const target = to + path.slice(from.length);
        this.files.set(target, this.files.get(path)!);
        this.files.delete(path);
        moved.push([path, target]);
      }
    }
    for (const dir of [...this.dirs]) {
      if (isInside(dir, from)) {
        this.dirs.delete(dir);
        this.dirs.add(to + dir.slice(from.length));
      }
    }
    this.emit({ type: 'rename', oldPath: from, newPath: to, kind: 'directory', files: moved });
    return to;
  }

  delete(path: string): void {
    const normalized = normalizePath(path);
    if (this.files.delete(normalized)) {
      this.emit({ type: 'delete', path: normalized, kind: 'file', files: [normalized] });
      return;
    }
    if (normalized === '' || !this.dirs.has(normalized)) throw new FsError(`"${path}" does not exist.`);
    const removed: string[] = [];
    for (const file of [...this.files.keys()]) {
      if (isInside(file, normalized)) {
        this.files.delete(file);
        removed.push(file);
      }
    }
    for (const dir of [...this.dirs]) {
      if (isInside(dir, normalized)) this.dirs.delete(dir);
    }
    this.emit({ type: 'delete', path: normalized, kind: 'directory', files: removed });
  }

  /** All file paths, sorted. */
  listFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Direct children of a folder: folders first, then files, each alphabetical. */
  readDirectory(dir = ''): DirectoryEntry[] {
    if (!this.isDirectory(dir)) throw new FsError(`"${dir}" is not a folder.`);
    const entries: DirectoryEntry[] = [];
    for (const path of this.dirs) {
      if (dirname(path) === dir) entries.push({ name: basename(path), path, kind: 'directory' });
    }
    for (const path of this.files.keys()) {
      if (dirname(path) === dir) entries.push({ name: basename(path), path, kind: 'file' });
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'directory' ? -1 : 1));
  }

  private ensureParents(path: string): void {
    for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) {
      if (this.files.has(dir)) throw new FsError(`"${dir}" is a file, not a folder.`);
      this.dirs.add(dir);
    }
  }

  private emit(event: FsEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
