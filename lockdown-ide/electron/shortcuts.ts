// Keyboard policy, evaluated in the main process from `before-input-event`.
// That event fires before ANY frame sees the key (including the sandboxed
// preview iframe), so these rules hold no matter where focus is. The function
// is pure so it can be unit-tested without Electron.

import type { AppCommand } from '../shared/ipc';

/** Subset of Electron's `Input` that the policy looks at. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export type KeyDecision =
  | { action: 'devtools' } // a DevTools shortcut: blocked unless DevTools are explicitly allowed
  | { action: 'block' } // swallowed silently (e.g. reload, which would wipe the in-memory workspace)
  | { action: 'command'; command: AppCommand }; // forwarded to the renderer

export function classifyKey(input: KeyInput, platform: string): KeyDecision | null {
  if (input.type !== 'keyDown') return null;

  const isMac = platform === 'darwin';
  // "mod" is Cmd on macOS and Ctrl elsewhere.
  const mod = isMac ? input.meta : input.control;
  const letter = letterOf(input);

  // --- DevTools: F12, Ctrl+Shift+I/J/C (Windows/Linux), Cmd+Alt+I/J/C and Cmd+Shift+C (macOS).
  if (input.key === 'F12') return { action: 'devtools' };
  if (mod && input.shift && (letter === 'i' || letter === 'j' || letter === 'c')) return { action: 'devtools' };
  if (isMac && input.meta && input.alt && (letter === 'i' || letter === 'j' || letter === 'c')) return { action: 'devtools' };

  // --- Reload / view-source: would discard the in-memory workspace or expose source.
  if (mod && (letter === 'r' || letter === 'u')) return { action: 'block' };

  // --- App commands (VS Code-style bindings).
  if (input.key === 'F5' && !mod && !input.shift && !input.alt) return command('run');
  if (mod && !input.alt && letter === 's') return command(input.shift ? 'save-all' : 'save');
  if (mod && !input.alt && !input.shift && letter === 'n') return command('new-file');
  if (mod && !input.alt && !input.shift && letter === 'w') return command('close-tab');
  if (mod && !input.alt && !input.shift && letter === 'b') return command('toggle-sidebar');
  if (mod && input.shift && !input.alt && letter === 'v') return command('toggle-preview');
  // Ctrl (not Cmd) on every platform, matching VS Code.
  if (input.control && input.code === 'Backquote') return command('toggle-console');
  if (input.control && input.key === 'Tab') return command(input.shift ? 'prev-tab' : 'next-tab');

  return null;
}

function command(command: AppCommand): KeyDecision {
  return { action: 'command', command };
}

/**
 * Lower-case letter for the key. Uses the physical key code as a fallback
 * because on macOS Alt changes `key` (Cmd+Alt+I reports "ˆ").
 */
function letterOf(input: KeyInput): string {
  if (/^[a-z]$/i.test(input.key)) return input.key.toLowerCase();
  const match = /^Key([A-Z])$/.exec(input.code);
  return match ? match[1].toLowerCase() : '';
}
