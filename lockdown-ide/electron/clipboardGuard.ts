// SECURITY: OS clipboard sentinel (main process).
//
// The renderer never writes to the OS clipboard: its copy/cut/paste handlers
// use an internal buffer. This guard is the backstop for every path the
// renderer cannot see, e.g. a nested iframe created by user code in the
// preview, or a screenshot tool dropping an image on the clipboard while the
// IDE is focused.
//
//  * On focus we fingerprint the OS clipboard.
//  * On blur, if the fingerprint changed while the IDE had focus, something
//    inside the IDE wrote to it, so we clear it before the user can paste it
//    anywhere else.
//  * On Linux, selecting text also publishes it to the X11/Wayland PRIMARY
//    selection (middle-click paste). We clear that buffer continuously while
//    the IDE is focused, and on blur.

import { clipboard, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';

const PRIMARY_SELECTION_POLL_MS = 300;

/** Hash of everything currently on the OS clipboard (all formats). */
async function fingerprint(): Promise<string> {
  const hash = createHash('sha256');
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        hash.update(type).update('\0');
        const data: unknown = await item.getType(type).catch(() => null);
        if (data && typeof (data as Blob).arrayBuffer === 'function') {
          hash.update(new Uint8Array(await (data as Blob).arrayBuffer()));
        } else if (data) {
          hash.update(JSON.stringify(data));
        }
        hash.update('\0');
      }
    }
  } catch {
    hash.update('unreadable');
  }
  return hash.digest('hex');
}

export function installClipboardGuard(win: BrowserWindow, log: (message: string) => void): void {
  // Linux only: the PRIMARY selection buffer.
  const primary = process.platform === 'linux' ? clipboard.selection : undefined;
  let baseline = fingerprint();
  let selectionTimer: NodeJS.Timeout | undefined;

  const clearPrimarySelection = async () => {
    try {
      if (primary && (await primary.readText())) primary.clear();
    } catch {
      /* no selection owner */
    }
  };

  const onFocus = () => {
    baseline = fingerprint();
    if (primary && !selectionTimer) {
      selectionTimer = setInterval(() => void clearPrimarySelection(), PRIMARY_SELECTION_POLL_MS);
    }
  };

  const onBlur = async () => {
    if (selectionTimer) {
      clearInterval(selectionTimer);
      selectionTimer = undefined;
    }
    await clearPrimarySelection();
    const [before, now] = await Promise.all([baseline, fingerprint()]);
    if (before !== now) {
      clipboard.clear();
      log('The OS clipboard changed while Lockdown IDE was focused, so it has been cleared.');
    }
    baseline = fingerprint();
  };

  win.on('focus', onFocus);
  win.on('blur', () => void onBlur());
  win.on('closed', () => {
    if (selectionTimer) clearInterval(selectionTimer);
  });
  if (win.isFocused()) onFocus();
}
