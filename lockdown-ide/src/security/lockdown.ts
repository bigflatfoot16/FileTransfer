// SECURITY: renderer-side lockdowns. The main process enforces the same
// rules (security.ts), so these are defence in depth plus user feedback.

/** Matches F12, Ctrl+Shift+I/J/C and Cmd+Alt+I/J/C. */
export function isDevToolsShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  if (event.key === 'F12') return true;
  const letter = /^Key([IJC])$/.exec(event.code)?.[1] ?? '';
  if (!letter) return false;
  const mod = event.ctrlKey || event.metaKey;
  return (mod && event.shiftKey) || (event.metaKey && event.altKey);
}

function blockAsyncClipboard(): void {
  // navigator.clipboard is the one clipboard route that doesn't go through
  // copy/paste events. Replace it with a stub that always refuses. (The main
  // process also denies the clipboard-read/-write permissions.)
  const refuse = () => Promise.reject(new DOMException('The system clipboard is disabled in Lockdown IDE.', 'NotAllowedError'));
  const blocked = Object.freeze({
    read: refuse,
    readText: refuse,
    write: refuse,
    writeText: refuse,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: false, enumerable: true, get: () => blocked });
}

export function installLockdown(notify: (message: string) => void): void {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // No right-click context menu anywhere (its Copy/Paste entries included).
  window.addEventListener('contextmenu', swallow, true);

  // DevTools shortcuts.
  window.addEventListener(
    'keydown',
    (event) => {
      if (isDevToolsShortcut(event)) swallow(event);
    },
    true,
  );

  // Drag-and-drop: nothing can be dragged out of the IDE (dragged text lands
  // in other apps without touching the clipboard), and nothing can be dropped
  // in (dropping text or files would bypass the paste block).
  window.addEventListener(
    'dragstart',
    (event) => {
      swallow(event);
      notify('Dragging content out of Lockdown IDE is disabled.');
    },
    true,
  );
  for (const type of ['dragenter', 'dragover'] as const) {
    window.addEventListener(
      type,
      (event) => {
        // Not calling preventDefault() is what marks the page as "not a drop target".
        event.stopImmediatePropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      },
      true,
    );
  }
  window.addEventListener(
    'drop',
    (event) => {
      swallow(event);
      notify('Dropping files or text into Lockdown IDE is disabled.');
    },
    true,
  );

  blockAsyncClipboard();

  // Printing could "export" code as a PDF; opening windows could navigate out.
  window.print = () => notify('Printing is disabled in Lockdown IDE.');
  window.open = () => null;
}
