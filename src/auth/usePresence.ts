// Tells the API "I'm here" (POST /me/seen, D-026): right away, then once a minute while the app stays open
// and visible. Hidden tab or app in the background: the check-ins stop, so the player drops out of
// "online now" within 2 minutes. Coming back sends one at once.
// Each check-in also carries the usage counted since the last one (src/usage/tracker.ts, D-036) as its body; when
// nothing was counted it goes without a body, as before. Going to the background sends one last check-in with what
// is left, with keepalive so the browser still sends it if the tab is being closed, and then the check-ins stop.
// The server decides what counts as a new visit; the app only checks in.
// Best effort: a failed check-in puts its usage back for the next one, a minute later, when the server surely
// wrote none of it (keepAfterFailure), and is otherwise ignored.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { UsageReport } from '../../api/src/contract';
import { ApiError, apiFetch } from '../api';
import { keepAfterFailure, usage } from '../usage/tracker';

// apiFetch's 10 s timeout aborts the request. The browser's DOMException and React Native's polyfill both name it so.
const isTimeout = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';

const EVERY_MS = 60_000;

export function usePresence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let live = true;   // false after logout: a late failure must not put this player's usage back for the next player

    // A failed check-in's report goes back only when the server wrote none of it. Not after a 400 (sent again it
    // would be refused again, with every check-in after it), and not after the timeout (the server may still
    // write it, and sending it again would count it twice).
    const send = (report: UsageReport | null, keepalive = false) => {
      apiFetch('/me/seen', { method: 'POST', body: report ? JSON.stringify(report) : undefined, keepalive }).catch((e) => {
        if (live && report && keepAfterFailure(e instanceof ApiError ? e.status : null, isTimeout(e))) usage.putBack(report);
      });
    };
    const start = () => {
      if (timer) return;
      send(usage.take(Date.now()));
      timer = setInterval(() => send(usage.take(Date.now())), EVERY_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    // Only when there is usage left: a plain check-in here would keep the player "online" after they left.
    const leave = () => {
      stop();
      const report = usage.take(Date.now());
      if (report) send(report, true);
    };

    // On the web, react-native-web reports 'active' while the tab is visible and 'background' when hidden.
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => (state === 'active' ? start() : leave()));

    return () => {
      live = false;
      stop();
      sub.remove();
    };
  }, [enabled]);
}
