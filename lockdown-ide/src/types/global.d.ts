import type { LockdownBridge } from '../../shared/ipc';

declare global {
  interface Window {
    /** Exposed by electron/preload.ts. Missing when the page is opened outside the Electron shell. */
    lockdown?: LockdownBridge;
  }
}

export {};
