// Console panel: shows console.* output and uncaught errors from the preview
// iframe, plus notices from the IDE itself (e.g. blocked actions).

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'system';

const MAX_ENTRIES = 1000;

interface Entry {
  level: ConsoleLevel;
  message: string;
  count: number;
  element: HTMLElement;
}

const LEVEL_ICONS: Partial<Record<ConsoleLevel, string>> = {
  warn: 'codicon-warning',
  error: 'codicon-error',
  info: 'codicon-info',
  system: 'codicon-shield',
};

export class ConsolePanel {
  private readonly output: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly entries: Entry[] = [];
  private errorCount = 0;
  private preserve = false;
  private readonly closeListeners = new Set<() => void>();

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="pane-header">
        <span class="pane-title">Console</span>
        <span class="console-badge" hidden></span>
        <div class="pane-actions">
          <label class="checkbox" title="Keep output when the preview reloads">
            <input type="checkbox" data-action="preserve"> Preserve log
          </label>
          <button type="button" class="icon-button codicon codicon-clear-all" data-action="clear" title="Clear Console" aria-label="Clear Console"></button>
          <button type="button" class="icon-button codicon codicon-close" data-action="close" title="Hide Console (Ctrl+\`)" aria-label="Hide Console"></button>
        </div>
      </div>
      <div class="console-output" role="log" aria-live="polite"></div>`;
    this.output = root.querySelector('.console-output')!;
    this.badge = root.querySelector('.console-badge')!;
    root.querySelector('[data-action="clear"]')!.addEventListener('click', () => this.clear());
    root.querySelector('[data-action="close"]')!.addEventListener('click', () => {
      for (const listener of this.closeListeners) listener();
    });
    root.querySelector<HTMLInputElement>('[data-action="preserve"]')!.addEventListener('change', (event) => {
      this.preserve = (event.target as HTMLInputElement).checked;
    });
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  log(level: ConsoleLevel, message: string): void {
    const atBottom = this.output.scrollTop + this.output.clientHeight >= this.output.scrollHeight - 4;

    // Collapse identical consecutive messages into one row with a counter.
    const last = this.entries[this.entries.length - 1];
    if (last && last.level === level && last.message === message) {
      last.count += 1;
      let counter = last.element.querySelector<HTMLElement>('.console-count');
      if (!counter) {
        counter = document.createElement('span');
        counter.className = 'console-count';
        last.element.prepend(counter);
      }
      counter.textContent = String(last.count);
    } else {
      const element = document.createElement('div');
      element.className = `console-entry level-${level}`;
      const icon = LEVEL_ICONS[level];
      if (icon) {
        const iconEl = document.createElement('span');
        iconEl.className = `console-icon codicon ${icon}`;
        element.append(iconEl);
      }
      const text = document.createElement('span');
      text.className = 'console-text';
      text.textContent = message; // textContent: output is never parsed as HTML
      element.append(text);
      this.output.append(element);
      this.entries.push({ level, message, count: 1, element });
      if (this.entries.length > MAX_ENTRIES) this.entries.shift()!.element.remove();
    }

    if (level === 'error') {
      this.errorCount += 1;
      this.updateBadge();
    }
    if (atBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  /** Called when the preview reloads. */
  reset(reason: string): void {
    if (this.preserve) {
      const divider = document.createElement('div');
      divider.className = 'console-divider';
      divider.textContent = reason;
      this.output.append(divider);
      this.entries.length = 0; // don't merge across reloads
      this.output.scrollTop = this.output.scrollHeight;
    } else {
      this.clear();
    }
  }

  clear(): void {
    this.entries.length = 0;
    this.output.replaceChildren();
    this.errorCount = 0;
    this.updateBadge();
  }

  private updateBadge(): void {
    this.badge.hidden = this.errorCount === 0;
    this.badge.textContent = `${this.errorCount} error${this.errorCount === 1 ? '' : 's'}`;
  }
}
