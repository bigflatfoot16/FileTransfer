// Script injected as the very first <script> of every HTML page served to the
// preview iframe. It runs inside the sandboxed, opaque-origin frame, so it
// can only talk to the IDE through postMessage.
//
// The function is serialized with Function.prototype.toString(), so it must
// be completely self-contained: no imports and no references to module scope.

export function previewShim(): void {
  const MAX_MESSAGE_LENGTH = 10_000;
  const MAX_MESSAGES_PER_SECOND = 300;

  let windowStart = Date.now();
  let sentInWindow = 0;
  let throttled = false;

  const post = (type: string, data: Record<string, unknown> = {}): void => {
    try {
      window.parent.postMessage({ source: 'lockdown-preview', type, ...data }, '*');
    } catch {
      /* parent unreachable: nothing useful to do */
    }
  };

  const postConsole = (level: string, message: string): void => {
    // Rate-limit so an accidental `while (true) console.log(...)` cannot flood the IDE.
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      sentInWindow = 0;
      throttled = false;
    }
    if (++sentInWindow > MAX_MESSAGES_PER_SECOND) {
      if (!throttled) {
        throttled = true;
        post('console', { level: 'warn', message: 'Console output throttled: too many messages per second.' });
      }
      return;
    }
    const text = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}… (truncated)` : message;
    post('console', { level, message: text });
  };

  // ---------------------------------------------------------------------------
  // Value formatting (a tiny util.inspect)
  // ---------------------------------------------------------------------------
  const describe = (value: unknown, depth: number, ancestors: object[]): string => {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'string':
        return depth === 0 ? value : JSON.stringify(value);
      case 'bigint':
        return `${value}n`;
      case 'number':
      case 'boolean':
      case 'undefined':
        return String(value);
      case 'symbol':
        return value.toString();
      case 'function':
        return `ƒ ${value.name || 'anonymous'}()`;
    }
    const obj = value as Record<string, unknown>;
    if (ancestors.includes(obj)) return '[Circular]';
    if (obj instanceof Error) return obj.stack || `${obj.name}: ${obj.message}`;
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (obj instanceof RegExp) return String(obj);
    if (typeof Element !== 'undefined' && obj instanceof Element) {
      const id = obj.id ? `#${obj.id}` : '';
      const cls = typeof obj.className === 'string' && obj.className ? `.${obj.className.trim().split(/\s+/).join('.')}` : '';
      return `<${obj.tagName.toLowerCase()}${id}${cls}>`;
    }
    if (depth > 2) return Array.isArray(obj) ? `Array(${obj.length})` : '{…}';

    const next = [...ancestors, obj];
    const inner = (v: unknown) => describe(v, depth + 1, next);
    if (Array.isArray(obj)) {
      const items = obj.slice(0, 100).map(inner);
      if (obj.length > 100) items.push(`… ${obj.length - 100} more`);
      return `[${items.join(', ')}]`;
    }
    if (obj instanceof Map) {
      const items = [...obj.entries()].slice(0, 50).map(([k, v]) => `${inner(k)} => ${inner(v)}`);
      return `Map(${obj.size}) {${items.join(', ')}}`;
    }
    if (obj instanceof Set) {
      return `Set(${obj.size}) {${[...obj].slice(0, 50).map(inner).join(', ')}}`;
    }
    const ctor = Object.getPrototypeOf(obj)?.constructor?.name;
    const prefix = ctor && ctor !== 'Object' ? `${ctor} ` : '';
    const keys = Object.keys(obj);
    const props = keys.slice(0, 50).map((key) => {
      let shown: string;
      try {
        shown = inner(obj[key]);
      } catch {
        shown = '[Getter threw]';
      }
      return `${key}: ${shown}`;
    });
    if (keys.length > 50) props.push('…');
    return `${prefix}{${props.join(', ')}}`;
  };

  const format = (args: unknown[]): string => args.map((arg) => describe(arg, 0, [])).join(' ');

  // ---------------------------------------------------------------------------
  // Console capture
  // ---------------------------------------------------------------------------
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      postConsole(level, format(args));
      original(...args);
    };
  }
  console.dir = (...args: unknown[]) => postConsole('log', format(args));
  console.table = (...args: unknown[]) => postConsole('log', format(args));
  console.trace = (...args: unknown[]) => postConsole('log', `Trace: ${format(args)}`);
  console.assert = (condition?: boolean, ...args: unknown[]) => {
    if (!condition) postConsole('error', `Assertion failed${args.length ? `: ${format(args)}` : ''}`);
  };
  console.clear = () => post('clear');

  window.addEventListener('error', (event) => {
    if (!(event instanceof ErrorEvent)) return; // resource errors are reported by the preview server
    const where = event.filename ? ` (${event.filename.replace(/^lockdown-preview:\/\/workspace\//, '')}:${event.lineno}:${event.colno})` : '';
    const detail = event.error instanceof Error ? event.error.stack || String(event.error) : event.message;
    postConsole('error', `Uncaught ${detail}${where}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    postConsole('error', `Uncaught (in promise) ${describe(event.reason, 0, [])}`);
  });
  // CSP violations are how "no external URL access" surfaces to the user.
  document.addEventListener('securitypolicyviolation', (event) => {
    const blocked = event.blockedURI || event.effectiveDirective;
    postConsole('warn', `Blocked by Lockdown IDE (${event.effectiveDirective}): ${blocked}. The preview has no network access.`);
  });

  // ---------------------------------------------------------------------------
  // SECURITY: clipboard, drag-and-drop and context menu inside the preview.
  // The preview is a separate document, so the IDE's window-level clipboard
  // hooks never see its events. Without this, text rendered in the preview
  // could be selected and copied straight to the OS clipboard.
  // ---------------------------------------------------------------------------
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['copy', 'cut', 'paste'] as const) {
    window.addEventListener(
      type,
      (event) => {
        swallow(event);
        post('blocked', { action: type });
      },
      true,
    );
  }
  for (const type of ['dragstart', 'drop', 'contextmenu'] as const) {
    window.addEventListener(type, swallow, true);
  }
  try {
    // The Permissions Policy already denies the async clipboard to this
    // cross-origin frame; remove the API as well so failures are obvious.
    Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: false, get: () => undefined });
  } catch {
    /* already locked */
  }

  // ---------------------------------------------------------------------------
  // SECURITY: navigation. The iframe sandbox already blocks popups and top-level
  // navigation, and the main process vetoes any frame navigation off the
  // preview scheme; this just explains to the user what happened.
  // ---------------------------------------------------------------------------
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      const external = url.protocol !== location.protocol || url.host !== location.host;
      const popup = anchor.target !== '' && anchor.target !== '_self';
      if (external || popup) {
        event.preventDefault();
        postConsole('warn', `Navigation to ${url.href} was blocked: the preview cannot open external pages or new windows.`);
      }
    },
    true,
  );
  // Forms can't be submitted (CSP form-action 'none'); say so unless the page handled it itself.
  window.addEventListener('submit', (event) => {
    if (!event.defaultPrevented) {
      event.preventDefault();
      postConsole('info', 'Form submission is disabled in the preview. Handle the "submit" event in JavaScript instead.');
    }
  });

  // Modal dialogs are disabled by the sandbox (no allow-modals); route them to the console.
  window.alert = (message?: unknown) => postConsole('info', `alert: ${describe(message, 0, [])}`);
  window.confirm = (message?: string) => {
    postConsole('info', `confirm: ${message ?? ''} → false (dialogs are disabled in the preview)`);
    return false;
  };
  window.prompt = (message?: string) => {
    postConsole('info', `prompt: ${message ?? ''} → null (dialogs are disabled in the preview)`);
    return null;
  };
  window.print = () => postConsole('info', 'print() is disabled in the preview.');
}

/** Source served at /__lockdown__/shim.js. */
export const PREVIEW_SHIM_SOURCE = `(${previewShim.toString()})();\n`;
