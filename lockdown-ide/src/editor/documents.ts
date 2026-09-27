// Working copies. Every workspace file gets a Monaco model holding its
// (possibly unsaved) text; the virtual file system holds the saved text.
// A file is dirty when its model has changed since the last save, tracked with
// Monaco's alternative version id so that undoing back to the saved state
// clears the dirty marker, as in VS Code.

import { monaco } from './monaco';
import { languageForPath } from './languages';
import type { FsEvent, VirtualFileSystem } from './fileSystem';

interface Document {
  model: monaco.editor.ITextModel;
  /** Alternative version id at the last save, or -1 if the text was never saved at this path. */
  savedVersionId: number;
  wasDirty: boolean;
}

type Listener<T> = (value: T) => void;

export class DocumentManager {
  private readonly docs = new Map<string, Document>();
  private readonly dirtyListeners = new Set<Listener<string>>();
  private readonly contentListeners = new Set<Listener<string>>();
  private readonly renameListeners = new Set<Listener<Array<[string, string]>>>();
  private readonly deleteListeners = new Set<Listener<string[]>>();

  constructor(private readonly fs: VirtualFileSystem) {
    for (const path of fs.listFiles()) this.createDocument(path, fs.readFile(path));
    fs.onDidChange((event) => this.onFsChange(event));
  }

  /** Fired when a file's dirty state flips. */
  onDidChangeDirty(listener: Listener<string>): void {
    this.dirtyListeners.add(listener);
  }
  /** Fired on every edit of any working copy. */
  onDidChangeContent(listener: Listener<string>): void {
    this.contentListeners.add(listener);
  }
  /** Fired after models were re-created for renamed files ([old, new] pairs). */
  onDidRename(listener: Listener<Array<[string, string]>>): void {
    this.renameListeners.add(listener);
  }
  /** Fired after the models of deleted files were disposed. */
  onDidDelete(listener: Listener<string[]>): void {
    this.deleteListeners.add(listener);
  }

  getModel(path: string): monaco.editor.ITextModel | undefined {
    return this.docs.get(path)?.model;
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path);
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersionId;
  }

  dirtyPaths(): string[] {
    return [...this.docs.keys()].filter((path) => this.isDirty(path)).sort();
  }

  /** Commits the working copy to the virtual file system. */
  save(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.fs.writeFile(path, doc.model.getValue());
    doc.savedVersionId = doc.model.getAlternativeVersionId();
    this.updateDirty(path, doc);
  }

  saveAll(): string[] {
    const dirty = this.dirtyPaths();
    for (const path of dirty) this.save(path);
    return dirty;
  }

  /** Throws away unsaved edits. */
  revert(path: string): void {
    const doc = this.docs.get(path);
    if (!doc || !this.fs.isFile(path)) return;
    doc.model.setValue(this.fs.readFile(path));
    doc.savedVersionId = doc.model.getAlternativeVersionId();
    this.updateDirty(path, doc);
  }

  /** Current text of every file, including unsaved edits (what the preview renders). */
  workingCopies(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const [path, doc] of this.docs) files[path] = doc.model.getValue();
    return files;
  }

  private createDocument(path: string, content: string, savedVersionId?: number): Document {
    const uri = monaco.Uri.from({ scheme: 'file', path: `/${path}` });
    // A stale model can linger if a previous one was not disposed; reuse the URI safely.
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(content, languageForPath(path), uri);
    const doc: Document = { model, savedVersionId: savedVersionId ?? model.getAlternativeVersionId(), wasDirty: false };
    doc.wasDirty = model.getAlternativeVersionId() !== doc.savedVersionId;
    model.onDidChangeContent(() => {
      const current = this.pathOfDoc(doc);
      if (current === undefined) return;
      this.updateDirty(current, doc);
      for (const listener of this.contentListeners) listener(current);
    });
    this.docs.set(path, doc);
    return doc;
  }

  private pathOfDoc(doc: Document): string | undefined {
    for (const [path, candidate] of this.docs) if (candidate === doc) return path;
    return undefined;
  }

  private updateDirty(path: string, doc: Document): void {
    const dirty = doc.model.getAlternativeVersionId() !== doc.savedVersionId;
    if (dirty === doc.wasDirty) return;
    doc.wasDirty = dirty;
    for (const listener of this.dirtyListeners) listener(path);
  }

  private onFsChange(event: FsEvent): void {
    switch (event.type) {
      case 'create':
        if (event.kind === 'file' && !this.docs.has(event.path)) {
          this.createDocument(event.path, this.fs.readFile(event.path));
          for (const listener of this.contentListeners) listener(event.path);
        }
        break;
      case 'write': {
        // Saves come through here too; only sync if the model is not ahead.
        const doc = this.docs.get(event.path);
        const content = this.fs.readFile(event.path);
        if (doc && !this.isDirty(event.path) && doc.model.getValue() !== content) {
          doc.model.setValue(content);
          doc.savedVersionId = doc.model.getAlternativeVersionId();
        }
        break;
      }
      case 'delete':
        for (const path of event.files) {
          this.docs.get(path)?.model.dispose();
          this.docs.delete(path);
        }
        for (const listener of this.deleteListeners) listener(event.files);
        for (const listener of this.contentListeners) listener(event.path);
        break;
      case 'rename': {
        // Model URIs are immutable, so renaming means re-creating the model.
        // Unsaved edits carry over and stay marked as unsaved.
        for (const [from, to] of event.files) {
          const old = this.docs.get(from);
          if (!old) continue;
          const text = old.model.getValue();
          const dirty = this.isDirty(from);
          this.docs.delete(from);
          old.model.dispose();
          this.createDocument(to, text, dirty ? -1 : undefined);
        }
        for (const listener of this.renameListeners) listener(event.files);
        for (const listener of this.contentListeners) listener(event.newPath);
        break;
      }
    }
  }
}
