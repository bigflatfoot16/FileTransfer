// Minimal modal dialog (native confirm() only offers OK/Cancel).

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DialogOptions {
  title: string;
  message: string;
  buttons: DialogButton[];
  /** Button id returned when the dialog is dismissed with Escape. */
  cancelId: string;
}

export function showDialog(options: DialogOptions): Promise<string> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message">
        <div class="dialog-title" id="dialog-title"></div>
        <div class="dialog-message" id="dialog-message"></div>
        <div class="dialog-buttons"></div>
      </div>`;
    overlay.querySelector('.dialog-title')!.textContent = options.title;
    overlay.querySelector('.dialog-message')!.textContent = options.message;

    const buttonRow = overlay.querySelector('.dialog-buttons')!;
    const buttons = options.buttons.map((spec) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = spec.primary ? 'button button-primary' : 'button';
      button.textContent = spec.label;
      button.addEventListener('click', () => close(spec.id));
      buttonRow.append(button);
      return button;
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(options.cancelId);
      } else if (event.key === 'Tab') {
        // Keep focus inside the dialog.
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next].focus();
      }
    };

    function close(id: string) {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      previousFocus?.focus();
      resolve(id);
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.body.append(overlay);
    (buttons.find((_, i) => options.buttons[i].primary) ?? buttons[0]).focus();
  });
}
