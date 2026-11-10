// Tells the API "I'm here" (POST /me/seen, D-026): right away, then once a minute while the app stays open
// and visible. Hidden tab or app in the background: the check-ins stop, so the player drops out of
// "online now" within 2 minutes. Coming back sends one at once.
// The server decides what counts as a new visit; the app only checks in.
// Best effort: a failed check-in is ignored, and the next one a minute later tries again.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { apiFetch } from '../api';

const EVERY_MS = 60_000;

export function usePresence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const checkIn = () => {
      apiFetch('/me/seen', { method: 'POST' }).catch(() => {});
    };
    const start = () => {
      if (timer) return;
      checkIn();
      timer = setInterval(checkIn, EVERY_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    // On the web, react-native-web reports 'active' while the tab is visible and 'background' when hidden.
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => (state === 'active' ? start() : stop()));

    return () => {
      stop();
      sub.remove();
    };
  }, [enabled]);
}
