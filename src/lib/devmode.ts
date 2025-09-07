import { useEffect, useSyncExternalStore } from 'react';

type Listener = () => void;
let listeners = new Set<Listener>();
let active = false;
let timer: number | null = null;

function notify() { listeners.forEach((l) => l()); }

function loadFromSession() {
  try {
    const untilStr = sessionStorage.getItem('devmode_until');
    const until = untilStr ? parseInt(untilStr, 10) : 0;
    if (until > Date.now()) {
      active = true;
      const ms = Math.max(0, until - Date.now());
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { disable(); }, ms);
    } else {
      sessionStorage.removeItem('devmode_until');
    }
  } catch {}
}

loadFromSession();

export function enable(ms = 3 * 60 * 1000) {
  active = true;
  try { sessionStorage.setItem('devmode_until', String(Date.now() + ms)); } catch {}
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => { disable(); }, ms);
  notify();
}

export function disable() {
  active = false;
  try { sessionStorage.removeItem('devmode_until'); } catch {}
  if (timer) { try { window.clearTimeout(timer); } catch {}; timer = null; }
  notify();
}

export function getActive() { return active; }

export function subscribe(cb: Listener) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useDevMode() {
  const value = useSyncExternalStore(subscribe, getActive);
  return value;
}

