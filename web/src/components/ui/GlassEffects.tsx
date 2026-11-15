import { useEffect } from 'react';
/** Pointer light is local CSS, never React state per animation frame. */
export function GlassEffects() {
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let viewportBase = window.visualViewport?.height ?? window.innerHeight;
    let viewportWidth = window.innerWidth;
    let previous: HTMLElement | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || reduced.matches) return;
      const control = (e.target as Element).closest<HTMLElement>(
        '.primary, .platform-card, .liquid-nav',
      );
      if (previous && previous !== control) previous.style.removeProperty('--light-alpha');
      previous = control;
      if (!control) return;
      const rect = control.getBoundingClientRect();
      control.style.setProperty('--light-x', `${e.clientX - rect.left}px`);
      control.style.setProperty('--light-y', `${e.clientY - rect.top}px`);
      control.style.setProperty('--light-alpha', '1');
    };
    const leave = () => {
      previous?.style.removeProperty('--light-alpha');
      previous = null;
    };
    const press = (e: PointerEvent) => {
      if (reduced.matches || e.pointerType === 'mouse') return;
      const control = (e.target as Element).closest<HTMLElement>('.primary, .platform-card');
      if (!control) return;
      const rect = control.getBoundingClientRect();
      control.style.setProperty('--light-x', `${e.clientX - rect.left}px`);
      control.style.setProperty('--light-y', `${e.clientY - rect.top}px`);
      control.style.setProperty('--light-alpha', '1');
      const timer = setTimeout(() => {
        control.style.removeProperty('--light-alpha');
        timers.delete(timer);
      }, 350);
      timers.add(timer);
    };
    const scroll = () =>
      document.documentElement.classList.toggle('is-scrolled', window.scrollY > 16);
    const viewport = () => {
      const editing = document.activeElement?.matches('input,textarea,select');
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (Math.abs(window.innerWidth - viewportWidth) > 100) {
        viewportWidth = window.innerWidth;
        viewportBase = height;
      }
      if (!editing) viewportBase = Math.max(viewportBase, height);
      document.documentElement.classList.toggle(
        'keyboard-open',
        !!editing &&
          window.innerWidth <= 700 &&
          Math.max(viewportBase, window.innerHeight) - height > 170,
      );
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    window.addEventListener('scroll', scroll, { passive: true });
    document.addEventListener('pointerdown', press, { passive: true });
    scroll();
    window.visualViewport?.addEventListener('resize', viewport);
    document.addEventListener('focusout', viewport);
    document.addEventListener('focusin', viewport);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('pointerleave', leave);
      window.removeEventListener('scroll', scroll);
      window.visualViewport?.removeEventListener('resize', viewport);
      document.removeEventListener('focusout', viewport);
      document.removeEventListener('focusin', viewport);
      document.documentElement.classList.remove('keyboard-open');
      timers.forEach(clearTimeout);
      leave();
    };
  }, []);
  return null;
}
