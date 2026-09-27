import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  extname,
  FsError,
  normalizePath,
  validateName,
  VirtualFileSystem,
  type FsEvent,
} from '../../src/editor/fileSystem';

function recorded(fs: VirtualFileSystem): FsEvent[] {
  const events: FsEvent[] = [];
  fs.onDidChange((event) => events.push(event));
  return events;
}

describe('path helpers', () => {
  it('splits paths', () => {
    expect(dirname('a/b/c.js')).toBe('a/b');
    expect(dirname('c.js')).toBe('');
    expect(basename('a/b/c.js')).toBe('c.js');
    expect(extname('a/b/C.JS')).toBe('js');
    expect(extname('.gitignore')).toBe('');
    expect(extname('Makefile')).toBe('');
  });

  it('normalizes and validates', () => {
    expect(normalizePath('/a//b/')).toBe('a/b');
    expect(() => normalizePath('a/../b')).toThrow(FsError);
    expect(() => normalizePath('a/./b')).toThrow(FsError);
  });

  it('rejects bad names', () => {
    expect(validateName('index.html')).toBeNull();
    expect(validateName('')).not.toBeNull();
    expect(validateName(' x')).not.toBeNull();
    expect(validateName('a/b')).not.toBeNull();
    expect(validateName('a\\b')).not.toBeNull();
    expect(validateName('..')).not.toBeNull();
    expect(validateName('what?')).not.toBeNull();
  });
});

describe('VirtualFileSystem', () => {
  it('loads initial files and creates parent folders', () => {
    const fs = new VirtualFileSystem({ 'index.html': '<p>', 'css/site.css': 'body{}' });
    expect(fs.listFiles()).toEqual(['css/site.css', 'index.html']);
    expect(fs.isDirectory('css')).toBe(true);
    expect(fs.readFile('css/site.css')).toBe('body{}');
  });

  it('lists folders first, then files, naturally sorted', () => {
    const fs = new VirtualFileSystem({ 'b.js': '', 'a10.js': '', 'a2.js': '', 'z/x.js': '' });
    expect(fs.readDirectory().map((e) => e.name)).toEqual(['z', 'a2.js', 'a10.js', 'b.js']);
  });

  it('creates files and folders and emits events', () => {
    const fs = new VirtualFileSystem();
    const events = recorded(fs);
    fs.createDirectory('src');
    fs.createFile('src/app.js', 'x');
    expect(events).toEqual([
      { type: 'create', path: 'src', kind: 'directory' },
      { type: 'create', path: 'src/app.js', kind: 'file' },
    ]);
    expect(() => fs.createFile('src/app.js')).toThrow(/already exists/);
    expect(() => fs.createDirectory('src')).toThrow(/already exists/);
  });

  it('distinguishes write from create', () => {
    const fs = new VirtualFileSystem({ 'a.txt': '1' });
    const events = recorded(fs);
    fs.writeFile('a.txt', '2');
    expect(events).toEqual([{ type: 'write', path: 'a.txt' }]);
    expect(fs.readFile('a.txt')).toBe('2');
  });

  it('renames a file', () => {
    const fs = new VirtualFileSystem({ 'a.js': 'x' });
    const events = recorded(fs);
    expect(fs.rename('a.js', 'lib/b.js')).toBe('lib/b.js');
    expect(fs.listFiles()).toEqual(['lib/b.js']);
    expect(events[0]).toMatchObject({ type: 'rename', files: [['a.js', 'lib/b.js']] });
  });

  it('moves a folder with all of its contents', () => {
    const fs = new VirtualFileSystem({ 'src/a.js': 'a', 'src/deep/b.js': 'b', 'srcx/c.js': 'c' });
    const events = recorded(fs);
    fs.rename('src', 'app');
    expect(fs.listFiles()).toEqual(['app/a.js', 'app/deep/b.js', 'srcx/c.js']);
    expect(fs.isDirectory('app/deep')).toBe(true);
    expect(fs.isDirectory('src')).toBe(false);
    expect(events[0]).toMatchObject({ type: 'rename', kind: 'directory' });
    expect((events[0] as { files: unknown[] }).files).toHaveLength(2);
  });

  it('refuses to move a folder into itself or onto an existing path', () => {
    const fs = new VirtualFileSystem({ 'src/a.js': '', 'b.js': '' });
    expect(() => fs.rename('src', 'src/inner')).toThrow(/into itself/);
    expect(() => fs.rename('src/a.js', 'b.js')).toThrow(/already exists/);
  });

  it('deletes folders recursively', () => {
    const fs = new VirtualFileSystem({ 'src/a.js': '', 'src/deep/b.js': '', 'keep.js': '' });
    const events = recorded(fs);
    fs.delete('src');
    expect(fs.listFiles()).toEqual(['keep.js']);
    expect(fs.isDirectory('src/deep')).toBe(false);
    expect(events[0]).toMatchObject({ type: 'delete', kind: 'directory', files: ['src/a.js', 'src/deep/b.js'] });
  });

  it('does not allow a file where a folder is needed', () => {
    const fs = new VirtualFileSystem({ 'a.js': '' });
    expect(() => fs.createFile('a.js/b.js')).toThrow(FsError);
  });
});
