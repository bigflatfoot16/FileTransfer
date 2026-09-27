// Preload script: the only bridge between the sandboxed renderer and the main
// process. It runs with contextIsolation, so the renderer can reach nothing
// but the narrow, typed API below. Raw ipcRenderer is never exposed, and the
// IPC event object (which carries a sender reference) never leaves this file.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppCommand,
  type LockdownBridge,
  type PreviewLogEntry,
  type PreviewSnapshot,
  type WindowControl,
} from '../shared/ipc';

const bridge: LockdownBridge = {
  platform: process.platform,
  window: {
    control: (action: WindowControl) => ipcRenderer.send(IPC.windowControl, action),
    onMaximizedChange: (listener) => {
      ipcRenderer.on(IPC.windowState, (_event, maximized: boolean) => listener(maximized));
    },
  },
  preview: {
    publish: (snapshot: PreviewSnapshot) => ipcRenderer.invoke(IPC.previewPublish, snapshot),
    onLog: (listener) => {
      ipcRenderer.on(IPC.previewLog, (_event, entry: PreviewLogEntry) => listener(entry));
    },
    onNavigationBlocked: (listener) => {
      ipcRenderer.on(IPC.previewNavigationBlocked, (_event, url: string) => listener(url));
    },
  },
  onCommand: (listener) => {
    ipcRenderer.on(IPC.command, (_event, command: AppCommand) => listener(command));
  },
};

contextBridge.exposeInMainWorld('lockdown', bridge);
