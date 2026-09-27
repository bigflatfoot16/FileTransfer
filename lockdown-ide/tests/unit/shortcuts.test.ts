import { describe, expect, it } from 'vitest';
import { classifyKey, type KeyInput } from '../../electron/shortcuts';
import { isDevToolsShortcut } from '../../src/security/lockdown';

function key(key: string, mods: Partial<KeyInput> = {}): KeyInput {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === '`' ? 'Backquote' : key;
  return { type: 'keyDown', key, code, control: false, meta: false, shift: false, alt: false, ...mods };
}

describe('classifyKey (main process keyboard policy)', () => {
  it.each([
    ['F12', {}],
    ['I', { control: true, shift: true }],
    ['J', { control: true, shift: true }],
    ['C', { control: true, shift: true }],
  ])('treats %s as a DevTools shortcut on Windows/Linux', (k, mods) => {
    expect(classifyKey(key(k, mods), 'win32')).toEqual({ action: 'devtools' });
    expect(classifyKey(key(k, mods), 'linux')).toEqual({ action: 'devtools' });
  });

  it('catches Cmd+Alt+I on macOS even though Alt changes the key', () => {
    expect(classifyKey({ ...key('ˆ', { meta: true, alt: true }), code: 'KeyI' }, 'darwin')).toEqual({ action: 'devtools' });
  });

  it('blocks reload and view-source', () => {
    expect(classifyKey(key('r', { control: true }), 'win32')).toEqual({ action: 'block' });
    expect(classifyKey(key('R', { control: true, shift: true }), 'linux')).toEqual({ action: 'block' });
    expect(classifyKey(key('u', { control: true }), 'linux')).toEqual({ action: 'block' });
  });

  it('maps app shortcuts', () => {
    const cases: Array<[KeyInput, string]> = [
      [key('s', { control: true }), 'save'],
      [key('S', { control: true, shift: true }), 'save-all'],
      [key('F5'), 'run'],
      [key('n', { control: true }), 'new-file'],
      [key('w', { control: true }), 'close-tab'],
      [key('b', { control: true }), 'toggle-sidebar'],
      [key('V', { control: true, shift: true }), 'toggle-preview'],
      [key('`', { control: true }), 'toggle-console'],
      [key('Tab', { control: true }), 'next-tab'],
      [key('Tab', { control: true, shift: true }), 'prev-tab'],
    ];
    for (const [input, command] of cases) {
      expect(classifyKey(input, 'linux'), command).toEqual({ action: 'command', command });
    }
  });

  it('uses Cmd instead of Ctrl on macOS', () => {
    expect(classifyKey(key('s', { meta: true }), 'darwin')).toEqual({ action: 'command', command: 'save' });
    expect(classifyKey(key('s', { control: true }), 'darwin')).toBeNull();
  });

  it('works on non-Latin keyboard layouts', () => {
    expect(classifyKey({ ...key('ы', { control: true }), code: 'KeyS' }, 'linux')).toEqual({ action: 'command', command: 'save' });
  });

  it('leaves editing keys alone', () => {
    for (const input of [
      key('c', { control: true }),
      key('v', { control: true }),
      key('x', { control: true }),
      key('z', { control: true }),
      key('a'),
      key('F1'),
    ]) {
      expect(classifyKey(input, 'linux')).toBeNull();
    }
  });

  it('ignores key-up events', () => {
    expect(classifyKey({ ...key('F12'), type: 'keyUp' }, 'linux')).toBeNull();
  });
});

describe('isDevToolsShortcut (renderer)', () => {
  const ev = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  it('detects DevTools combinations', () => {
    expect(isDevToolsShortcut(ev('F12'))).toBe(true);
    expect(isDevToolsShortcut(ev('I', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isDevToolsShortcut(ev('j', { metaKey: true, altKey: true }))).toBe(true);
    expect(isDevToolsShortcut(ev('c', { ctrlKey: true }))).toBe(false);
    expect(isDevToolsShortcut(ev('i', { ctrlKey: true }))).toBe(false);
  });
});
