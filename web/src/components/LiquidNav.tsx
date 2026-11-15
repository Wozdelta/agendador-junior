import { useEffect, useId, useRef } from 'react';
import { Icon, type IconName } from './ui/Icon';
import {
  clampPill,
  LEADING,
  TRAILING,
  loopGeometry,
  loopTouch,
  spring,
  tabGeometry,
  type SpringState,
} from '../lib/liquid-motion';

export const NAV_ITEMS: { id: string; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'novo', label: 'Novo lote', icon: 'video' },
  { id: 'agenda', label: 'Agenda', icon: 'calendar' },
  { id: 'conexoes', label: 'Conexões', icon: 'link' },
  { id: 'config', label: 'Configurações', icon: 'settings' },
];
export function LiquidNav({
  route,
  onChange,
  loop = false,
  preview = false,
}: {
  route: string;
  onChange: (route: string) => void;
  loop?: boolean;
  preview?: boolean;
}) {
  const items = preview ? NAV_ITEMS.filter(i => i.id !== 'dashboard') : NAV_ITEMS;
  const nav = useRef<HTMLElement>(null),
    touch = useRef<HTMLDivElement>(null);
  const shadowId = useId();
  const state = useRef({
    left: { position: 0, velocity: 0 },
    right: { position: 0, velocity: 0 },
    initialized: false,
  });
  const selected = Math.max(
    0,
    items.findIndex((i) => i.id === route),
  );
  useEffect(() => {
    const el = nav.current!;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      width = el.clientWidth,
      start = performance.now();
    let fromLeft: SpringState,
      fromRight: SpringState,
      forward = true;
    function target() {
      if (width <= 0) return;
      if ((!loop || motion.matches) && touch.current) touch.current.style.opacity = '0';
      if (motion.matches) el.querySelectorAll('.nav-ripple').forEach((ripple) => ripple.remove());
      const to = tabGeometry(width, selected, items.length);
      if (!state.current.initialized || motion.matches) {
        state.current = {
          left: { position: to.left, velocity: 0 },
          right: { position: to.right, velocity: 0 },
          initialized: true,
        };
      }
      fromLeft = { ...state.current.left };
      fromRight = { ...state.current.right };
      forward = to.center >= (fromLeft.position + fromRight.position) / 2;
      start = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    }
    function draw(now: number) {
      if (width <= 0) return;
      const to = tabGeometry(width, selected, items.length),
        seconds = (now - start) / 1000;
      let active = selected;
      if (loop && !motion.matches) {
        const pose = loopGeometry(seconds, width);
        state.current.left = { position: pose.left, velocity: 0 };
        state.current.right = { position: pose.right, velocity: 0 };
        active = pose.index;
        const tap = loopTouch(seconds);
        if (touch.current) {
          touch.current.style.opacity = tap ? '1' : '0';
          if (tap) {
            const x = tabGeometry(width, tap.index, items.length).center;
            touch.current.style.setProperty('--tap-x', `${x}px`);
            touch.current.style.setProperty('--tap-scale', `${tap.scale}`);
            touch.current.style.setProperty('--tap-opacity', `${tap.opacity}`);
            touch.current.style.setProperty('--ring-scale', `${tap.ringScale}`);
            touch.current.style.setProperty('--ring-opacity', `${tap.ringOpacity}`);
            touch.current.querySelector('.loop-ring')?.setAttribute('r', `${23 * tap.ringScale}`);
          }
        }
      } else if (!motion.matches) {
        const l = forward ? TRAILING : LEADING,
          r = forward ? LEADING : TRAILING;
        state.current.left = spring(fromLeft, to.left, seconds, l.omega, l.zeta);
        state.current.right = spring(fromRight, to.right, seconds, r.omega, r.zeta);
      }
      const { left, right } = clampPill(
        width,
        state.current.left.position,
        state.current.right.position,
      );
      el.style.setProperty('--pill-left', `${left}px`);
      el.style.setProperty('--pill-width', `${right - left}px`);
      const center = (left + right) / 2;
      el.querySelectorAll<HTMLButtonElement>('.liquid-tab').forEach((button, i) => {
        const c = Math.max(
          0,
          Math.min(1, 1 - Math.abs(center - tabGeometry(width, i, items.length).center) / ((80 * width) / 410)),
        );
        button.style.color = `rgb(${[140, 138, 168].map((channel) => Math.round(channel + (255 - channel) * c)).join(',')})`;
        if (preview) {
          button.dataset.selected = String(i === active);
          button.setAttribute('aria-current', i === active ? 'page' : 'false');
        }
      });
      if ((loop && !motion.matches) || (!motion.matches && seconds < 1.8))
        frame = requestAnimationFrame(draw);
      else {
        el.style.setProperty('--pill-left', `${to.left}px`);
        el.style.setProperty('--pill-width', `${to.right - to.left}px`);
      }
    }
    target();
    const observer = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (Math.abs(next - width) > 0.5) {
        width = next;
        state.current.initialized = false;
        target();
      }
    });
    observer.observe(el);
    motion.addEventListener('change', target);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener('change', target);
    };
  }, [selected, loop, preview]);
  return (
    <nav
      ref={nav}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      className={`liquid-nav ${preview ? 'preview-nav' : ''}`}
      aria-label={preview ? 'Prévia da navegação' : 'Navegação principal'}
    >
      <div className="liquid-pill" aria-hidden="true" />
      {items.map((item) => (
        <button
          key={item.id}
          className="liquid-tab"
          data-route={item.id}
          data-selected={route === item.id}
          aria-current={route === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
          onPointerDown={(event) => {
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const rect = event.currentTarget.getBoundingClientRect(),
              navRect = nav.current!.getBoundingClientRect();
            const ripple = document.createElement('span');
            ripple.className = 'nav-ripple';
            ripple.setAttribute('aria-hidden', 'true');
            ripple.style.left = `${event.clientX ? event.clientX - navRect.left : rect.left - navRect.left + rect.width / 2}px`;
            ripple.style.top = `${event.clientY ? event.clientY - navRect.top : rect.top - navRect.top + rect.height / 2}px`;
            nav.current!.append(ripple);
            ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
          }}
        >
          <Icon name={item.icon} size={25} />
          <span>{item.label}</span>
        </button>
      ))}
      {preview && (
        <div className="loop-touch" ref={touch} aria-hidden="true">
          <i>
            <svg width="46" height="46" viewBox="0 0 46 46" overflow="visible">
              <defs>
                <filter id={shadowId} x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow
                    dx="0"
                    dy="0"
                    stdDeviation="5"
                    floodColor="#000"
                    floodOpacity=".35"
                  />
                </filter>
              </defs>
              <circle
                cx="23"
                cy="23"
                r="23"
                fill="#fff"
                fillOpacity=".38"
                filter={`url(#${shadowId})`}
              />
              <circle cx="23" cy="23" r="23" fill="none" stroke="#fff" strokeWidth="3.5" />
            </svg>
          </i>
          <b>
            <svg width="110" height="110" viewBox="0 0 110 110">
              <circle
                className="loop-ring"
                cx="55"
                cy="55"
                r="23"
                fill="none"
                stroke="#fff"
                strokeWidth="3"
              />
            </svg>
          </b>
        </div>
      )}
    </nav>
  );
}
