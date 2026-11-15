import { useEffect, useId, useRef } from 'react';
export function useDialogFocus(open: boolean, onClose: () => void) {
  const callback = useRef(onClose);
  callback.current = onClose;
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = document.querySelector<HTMLElement>('.modal-backdrop');
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const selector =
      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter(
        (el) =>
          !el.hasAttribute('hidden') &&
          !el.closest('[hidden]') &&
          el.getAttribute('aria-hidden') !== 'true',
      );
    dialog.tabIndex = -1;
    const heading = dialog.querySelector<HTMLElement>('h2');
    if (heading && !dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
      heading.id = titleId;
      dialog.setAttribute('aria-labelledby', titleId);
    }
    dialog.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        callback.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable(),
        first = elements[0],
        last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', keydown);
    return () => {
      dialog.removeEventListener('keydown', keydown);
      previous?.focus({ preventScroll: true });
    };
  }, [open, titleId]);
}
