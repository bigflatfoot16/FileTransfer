// Pure logic behind the lockdown-preview:// protocol. Kept free of Electron
// imports so it can be unit-tested in plain Node.

import { PREVIEW_HOST, PREVIEW_MAX_BYTES, PREVIEW_SCHEME } from '../shared/ipc';
import { PREVIEW_SHIM_SOURCE } from './previewShim';

export const SHIM_PATH = '__lockdown__/shim.js';

/**
 * SECURITY: Content-Security-Policy for everything the preview serves.
 * Only the preview scheme itself (plus inline code, data: and blob:) is
 * allowed, so user code cannot reach any network origin: no fetch/XHR/
 * WebSocket, no remote images/scripts/styles (which could smuggle code out
 * in a URL), no form posts and no <base> tricks.
 */
export const PREVIEW_CSP = [
  `default-src 'none'`,
  `script-src ${PREVIEW_SCHEME}: 'unsafe-inline' 'unsafe-eval'`,
  `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `img-src ${PREVIEW_SCHEME}: data: blob:`,
  `font-src ${PREVIEW_SCHEME}: data:`,
  `media-src ${PREVIEW_SCHEME}: data: blob:`,
  `connect-src ${PREVIEW_SCHEME}:`,
  `worker-src ${PREVIEW_SCHEME}: blob:`,
  `frame-src ${PREVIEW_SCHEME}:`,
  `form-action 'none'`,
  `base-uri 'none'`,
  `object-src 'none'`,
].join('; ');

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]{1,512}$/;

/**
 * Validates an untrusted snapshot coming over IPC and returns it as a Map.
 * Throws on anything unexpected rather than trying to repair it.
 */
export function validateSnapshot(input: unknown): Map<string, string> {
  if (typeof input !== 'object' || input === null) throw new Error('Snapshot must be an object');
  const files = (input as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new Error('Snapshot.files must be an object');

  const result = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!SAFE_PATH.test(path)) throw new Error(`Invalid path in snapshot: ${JSON.stringify(path)}`);
    if (typeof content !== 'string') throw new Error(`Content for ${path} must be a string`);
    totalBytes += content.length * 2;
    if (totalBytes > PREVIEW_MAX_BYTES) throw new Error('Snapshot too large');
    result.set(path, content);
  }
  return result;
}

/** Maps a lockdown-preview:// URL to a workspace path, or null if it is not ours. */
export function resolvePreviewPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:` || url.host !== PREVIEW_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  // The URL parser already collapses "..", but never trust it for a path.
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return path;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  txt: 'text/plain',
  md: 'text/plain',
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // Anything unknown (e.g. .ts or .py) is served as plain text; with nosniff
  // the browser will refuse to execute it as a script.
  return `${CONTENT_TYPES[ext] ?? 'text/plain'}; charset=utf-8`;
}

/**
 * Inserts the shim <script> so it runs before any user code: right after
 * <head>, else after <html>, else after the doctype (prepending before the
 * doctype would flip the page into quirks mode), else at the very start.
 */
export function injectShim(html: string): string {
  const tag = `<script src="/${SHIM_PATH}"></script>`;
  for (const pattern of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

export interface PreviewResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** Set when the page asked for a file that does not exist in the workspace. */
  missing?: string;
}

export function buildPreviewResponse(files: ReadonlyMap<string, string>, rawUrl: string): PreviewResponse {
  const headers: Record<string, string> = {
    'Content-Security-Policy': PREVIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    // The sandboxed frame has an opaque ("null") origin; module scripts and
    // fetch() of workspace files are CORS requests, so allow them.
    'Access-Control-Allow-Origin': '*',
  };
  const path = resolvePreviewPath(rawUrl);
  if (path === null) {
    return { status: 400, body: 'Bad request', headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } };
  }
  if (path === SHIM_PATH) {
    return { status: 200, body: PREVIEW_SHIM_SOURCE, headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } };
  }
  const content = files.get(path);
  if (content === undefined) {
    return {
      status: 404,
      body: `File not found in workspace: ${path}`,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      missing: path,
    };
  }
  const type = contentTypeFor(path);
  const body = type.startsWith('text/html') ? injectShim(content) : content;
  return { status: 200, body, headers: { ...headers, 'Content-Type': type } };
}
