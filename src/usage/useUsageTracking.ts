// Feeds the shared usage counter (src/usage/tracker.ts, D-036) with what the app sees: which route is open, whether
// the app is in the foreground, and, on the web, whether someone is using the page. It sends nothing itself;
// usePresence takes the counts with each check-in.
// Phones get no input listener, so there only "app in the foreground" counts (the tracker's idle cut-off stays off).

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { pageOf, usage } from './tracker';

// Input is only "someone is still here" for the idle cut-off (5 minutes), so one call every few seconds is plenty.
// A mouse moving across the page fires dozens of events a second.
const THROTTLE_MS = 5_000;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'] as const;
// Capture, because scroll doesn't bubble: react-native-web scrolls inner elements, never the document itself.
// Passive, because we never cancel anything.
const LISTEN = { capture: true, passive: true };

export function useUsageTracking(enabled: boolean) {
  const pathname = usePathname();

  // The open page. Every route change is a new view and counts as input.
  useEffect(() => {
    if (!enabled) return;
    usage.startPage(pageOf(pathname), Date.now());
  }, [enabled, pathname]);

  // Foreground or not. On the web, react-native-web reports 'active' while the tab is visible.
  useEffect(() => {
    if (!enabled) return;
    const apply = (active: boolean) => (active ? usage.resume(Date.now()) : usage.pause(Date.now()));
    apply(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (state) => apply(state === 'active'));
    return () => {
      sub.remove();
      // Logged out: stop counting and drop what wasn't sent. It can't go without this player's token, and it must
      // never ride on the next player's check-in.
      usage.startPage(null, Date.now());
      usage.take(Date.now());
    };
  }, [enabled]);

  // Web only: any input says someone is still using the page.
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    let last = 0;
    const onInput = () => {
      const now = Date.now();
      if (now - last < THROTTLE_MS) return;
      last = now;
      usage.activity(now);
    };
    usage.watchInput(true, Date.now());
    for (const type of INPUT_EVENTS) document.addEventListener(type, onInput, LISTEN);
    return () => {
      for (const type of INPUT_EVENTS) document.removeEventListener(type, onInput, LISTEN);
      usage.watchInput(false, Date.now());
    };
  }, [enabled]);
}
