import { describe, expect, it } from 'vitest';
import {
  buildPreviewResponse,
  contentTypeFor,
  injectShim,
  PREVIEW_CSP,
  resolvePreviewPath,
  SHIM_PATH,
  validateSnapshot,
} from '../../electron/previewContent';

const BASE = 'lockdown-preview://workspace';

describe('validateSnapshot', () => {
  it('accepts workspace files', () => {
    expect(validateSnapshot({ files: { 'index.html': 'x', 'css/a.css': 'y' } })).toEqual(
      new Map([
        ['index.html', 'x'],
        ['css/a.css', 'y'],
      ]),
    );
  });

  it.each([null, 'x', { files: null }, { files: [] }, { files: { 'a.js': 1 } }])('rejects malformed input %j', (input) => {
    expect(() => validateSnapshot(input)).toThrow();
  });

  it.each(['/etc/passwd', '../secret', 'a/../../b', 'a\\b', './a', ''])('rejects unsafe path %j', (path) => {
    expect(() => validateSnapshot({ files: { [path]: 'x' } })).toThrow();
  });

  it('rejects oversized snapshots', () => {
    expect(() => validateSnapshot({ files: { 'big.txt': 'x'.repeat(13 * 1024 * 1024) } })).toThrow(/too large/);
  });
});

describe('resolvePreviewPath', () => {
  it('maps URLs to workspace paths', () => {
    expect(resolvePreviewPath(`${BASE}/index.html?v=3`)).toBe('index.html');
    expect(resolvePreviewPath(`${BASE}/`)).toBe('index.html');
    expect(resolvePreviewPath(`${BASE}/pages/`)).toBe('pages/index.html');
    expect(resolvePreviewPath(`${BASE}/my%20file.html`)).toBe('my file.html');
  });

  it('refuses other hosts and schemes', () => {
    expect(resolvePreviewPath('lockdown-preview://evil/index.html')).toBeNull();
    expect(resolvePreviewPath('https://workspace/index.html')).toBeNull();
    expect(resolvePreviewPath('not a url')).toBeNull();
  });

  it('never resolves outside the workspace', () => {
    // The URL parser clamps dot segments at the root…
    expect(resolvePreviewPath(`${BASE}/%2e%2e/secret`)).toBe('secret');
    expect(resolvePreviewPath(`${BASE}/a/%2E%2E/%2E%2E/b`)).toBe('b');
    // …but encoded slashes survive parsing, so ".." segments are rejected after decoding.
    expect(resolvePreviewPath(`${BASE}/a%2F..%2F..%2Fb`)).toBeNull();
    expect(resolvePreviewPath(`${BASE}/a%2F.%2Fb`)).toBeNull();
  });
});

describe('injectShim', () => {
  const tag = `<script src="/${SHIM_PATH}"></script>`;
  it('goes right after <head>', () => {
    expect(injectShim('<!DOCTYPE html><html><head lang="x"><title>t</title></head></html>')).toBe(
      `<!DOCTYPE html><html><head lang="x">${tag}<title>t</title></head></html>`,
    );
  });
  it('falls back to <html>, then the doctype, then the start', () => {
    expect(injectShim('<html><body></body></html>')).toBe(`<html>${tag}<body></body></html>`);
    expect(injectShim('<!doctype html><p>hi')).toBe(`<!doctype html>${tag}<p>hi`);
    expect(injectShim('<p>hi</p>')).toBe(`${tag}<p>hi</p>`);
  });
  it('does not match <header>', () => {
    expect(injectShim('<header></header>')).toBe(`${tag}<header></header>`);
  });
});

describe('buildPreviewResponse', () => {
  const files = new Map([
    ['index.html', '<html><head></head><body>hi</body></html>'],
    ['app.js', 'console.log(1)'],
  ]);

  it('serves HTML with the shim and a locked-down CSP', () => {
    const res = buildPreviewResponse(files, `${BASE}/index.html`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`<script src="/${SHIM_PATH}"></script>`);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.headers['Content-Security-Policy']).toBe(PREVIEW_CSP);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves scripts untouched', () => {
    const res = buildPreviewResponse(files, `${BASE}/app.js`);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
  });

  it('serves the shim itself', () => {
    const res = buildPreviewResponse(files, `${BASE}/${SHIM_PATH}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('lockdown-preview');
    // It must be valid JavaScript.
    expect(() => new Function(res.body)).not.toThrow();
  });

  it('reports missing files', () => {
    const res = buildPreviewResponse(files, `${BASE}/missing.css`);
    expect(res.status).toBe(404);
    expect(res.missing).toBe('missing.css');
  });

  it('never allows network origins in the CSP', () => {
    expect(PREVIEW_CSP).not.toMatch(/https?:|wss?:|\*/);
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
  });

  it('serves unknown types as plain text', () => {
    expect(contentTypeFor('main.py')).toBe('text/plain; charset=utf-8');
    expect(contentTypeFor('types.ts')).toBe('text/plain; charset=utf-8');
  });
});
