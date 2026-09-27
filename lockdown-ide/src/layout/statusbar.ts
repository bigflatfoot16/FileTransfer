// Status bar: lockdown indicator, transient notices, cursor position, language.

const NOTICE_MS = 4000;

export class StatusBar {
  private readonly notice: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly language: HTMLElement;
  private noticeTimer: number | undefined;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="status-left">
        <span class="status-item status-lock" title="Clipboard is internal-only; screenshots, DevTools and external navigation are blocked.">
          <span class="codicon codicon-lock"></span> Locked down
        </span>
        <span class="status-item status-notice" role="status" aria-live="polite" hidden></span>
      </div>
      <div class="status-right">
        <span class="status-item status-cursor"></span>
        <span class="status-item status-language"></span>
      </div>`;
    this.notice = root.querySelector('.status-notice')!;
    this.cursor = root.querySelector('.status-cursor')!;
    this.language = root.querySelector('.status-language')!;
  }

  setCursor(line: number, column: number, selected: number): void {
    this.cursor.textContent = `Ln ${line}, Col ${column}${selected ? ` (${selected} selected)` : ''}`;
  }

  setLanguage(label: string): void {
    this.language.textContent = label;
  }

  clearEditorInfo(): void {
    this.cursor.textContent = '';
    this.language.textContent = '';
  }

  /** Shows a short-lived message, e.g. "Saved index.html" or a blocked action. */
  notify(message: string, kind: 'info' | 'warning' = 'info'): void {
    this.notice.textContent = message;
    this.notice.className = `status-item status-notice ${kind}`;
    this.notice.hidden = false;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice.hidden = true;
    }, NOTICE_MS);
  }
}
