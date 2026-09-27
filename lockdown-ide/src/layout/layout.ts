// Workbench layout: collapsible sidebar, toggleable/resizable preview and
// console, all resized by dragging the sashes between them.

export type Part = 'sidebar' | 'preview' | 'console';

interface PartState {
  visible: boolean;
  size: number;
}

type LayoutState = Record<Part, PartState>;

const STORAGE_KEY = 'lockdown.layout.v1';
const DEFAULTS: LayoutState = {
  sidebar: { visible: true, size: 220 },
  preview: { visible: true, size: 520 },
  console: { visible: true, size: 180 },
};

export interface LayoutElements {
  workbench: HTMLElement;
  sidebar: HTMLElement;
  editorRow: HTMLElement;
  preview: HTMLElement;
  mainArea: HTMLElement;
  console: HTMLElement;
  sashes: Record<Part, HTMLElement>;
}

export class Layout {
  private state: LayoutState;
  private readonly listeners = new Set<(part: Part, visible: boolean) => void>();

  constructor(private readonly el: LayoutElements) {
    this.state = Layout.load();
    for (const part of ['sidebar', 'preview', 'console'] as const) this.installSash(part);
    window.addEventListener('resize', () => this.apply());
    this.apply();
  }

  onDidChangeVisibility(listener: (part: Part, visible: boolean) => void): void {
    this.listeners.add(listener);
  }

  isVisible(part: Part): boolean {
    return this.state[part].visible;
  }

  toggle(part: Part): void {
    this.setVisible(part, !this.state[part].visible);
  }

  setVisible(part: Part, visible: boolean): void {
    if (this.state[part].visible === visible) return;
    this.state[part].visible = visible;
    this.apply();
    this.save();
    for (const listener of this.listeners) listener(part, visible);
  }

  private apply(): void {
    const { sidebar, preview, console: panel } = this.state;
    this.el.sidebar.hidden = !sidebar.visible;
    this.el.sashes.sidebar.hidden = !sidebar.visible;
    this.el.sidebar.style.width = `${this.clamp('sidebar', sidebar.size)}px`;

    this.el.preview.hidden = !preview.visible;
    this.el.sashes.preview.hidden = !preview.visible;
    this.el.preview.style.width = `${this.clamp('preview', preview.size)}px`;

    this.el.console.hidden = !panel.visible;
    this.el.sashes.console.hidden = !panel.visible;
    this.el.console.style.height = `${this.clamp('console', panel.size)}px`;
  }

  /** Keeps every pane usable however small the window gets. */
  private clamp(part: Part, size: number): number {
    const limits: Record<Part, [number, number]> = {
      sidebar: [160, Math.max(160, Math.min(520, this.el.workbench.clientWidth - 400))],
      preview: [220, Math.max(220, this.el.editorRow.clientWidth - 280)],
      console: [80, Math.max(80, this.el.mainArea.clientHeight - 140)],
    };
    const [min, max] = limits[part];
    return Math.round(Math.min(max, Math.max(min, size)));
  }

  private installSash(part: Part): void {
    const sash = this.el.sashes[part];
    sash.addEventListener('dblclick', () => {
      this.state[part].size = DEFAULTS[part].size;
      this.apply();
      this.save();
    });
    sash.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      sash.setPointerCapture(event.pointerId);
      // The preview iframe would otherwise swallow pointer events mid-drag.
      document.body.classList.add('resizing', part === 'console' ? 'resizing-row' : 'resizing-col');

      const onMove = (move: PointerEvent) => {
        if (part === 'sidebar') {
          this.state.sidebar.size = move.clientX - this.el.sidebar.getBoundingClientRect().left;
        } else if (part === 'preview') {
          this.state.preview.size = this.el.editorRow.getBoundingClientRect().right - move.clientX;
        } else {
          this.state.console.size = this.el.mainArea.getBoundingClientRect().bottom - move.clientY;
        }
        this.state[part].size = this.clamp(part, this.state[part].size);
        this.apply();
      };
      const onUp = () => {
        sash.removeEventListener('pointermove', onMove);
        sash.removeEventListener('pointerup', onUp);
        sash.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('resizing', 'resizing-row', 'resizing-col');
        this.save();
      };
      sash.addEventListener('pointermove', onMove);
      sash.addEventListener('pointerup', onUp);
      sash.addEventListener('pointercancel', onUp);
    });
  }

  // Layout sizes are harmless UI preferences, so localStorage is fine for them.
  private static load(): LayoutState {
    const state = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<LayoutState> | null;
      for (const part of ['sidebar', 'preview', 'console'] as const) {
        const value = saved?.[part];
        if (value && typeof value.visible === 'boolean' && Number.isFinite(value.size)) state[part] = { ...value };
      }
    } catch {
      /* corrupt or unavailable storage: use defaults */
    }
    return state;
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable */
    }
  }
}
