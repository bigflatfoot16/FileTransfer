// Contract between the Electron main process, the preload script and the
// renderer. Keep this file free of runtime dependencies: it is bundled into
// both the (Node) main process and the (sandboxed) preload.

export const IPC = {
  windowControl: 'lockdown:window-control',
  windowState: 'lockdown:window-state',
  previewPublish: 'lockdown:preview-publish',
  previewLog: 'lockdown:preview-log',
  previewNavigationBlocked: 'lockdown:preview-navigation-blocked',
  command: 'lockdown:command',
} as const;

/** Custom scheme that serves the renderer in production builds. */
export const APP_SCHEME = 'lockdown';
/** Custom scheme that serves the live-preview snapshot to the sandboxed iframe. */
export const PREVIEW_SCHEME = 'lockdown-preview';
export const PREVIEW_HOST = 'workspace';
export const PREVIEW_ORIGIN = `${PREVIEW_SCHEME}://${PREVIEW_HOST}`;

/** Upper bound for a preview snapshot, so a runaway renderer can't exhaust main-process memory. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

export type WindowControl = 'minimize' | 'toggle-maximize' | 'close';

/**
 * App-level shortcuts. The main process intercepts these keys before any page
 * (including the preview iframe) sees them and forwards the command, so they
 * work no matter where focus is.
 */
export type AppCommand =
  | 'save'
  | 'save-all'
  | 'run'
  | 'new-file'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'toggle-sidebar'
  | 'toggle-preview'
  | 'toggle-console';

export interface PreviewSnapshot {
  /** Workspace-relative path → file content. */
  files: Record<string, string>;
}

export interface PreviewLogEntry {
  level: 'warn' | 'error' | 'info';
  message: string;
}

/** API exposed on `window.lockdown` by the preload script. */
export interface LockdownBridge {
  platform: string;
  window: {
    control(action: WindowControl): void;
    onMaximizedChange(listener: (maximized: boolean) => void): void;
  };
  preview: {
    /** Replaces the snapshot served under lockdown-preview://workspace/. */
    publish(snapshot: PreviewSnapshot): Promise<void>;
    /** Messages from the preview server (e.g. a 404 for a missing file). */
    onLog(listener: (entry: PreviewLogEntry) => void): void;
    /** The preview frame tried to navigate off the workspace (the main process stopped it). */
    onNavigationBlocked(listener: (url: string) => void): void;
  };
  onCommand(listener: (command: AppCommand) => void): void;
}
