// Real ms since this clock was loaded, ticking while the admin has the clock running (D-017). With liveTime()
// (liveClock.ts) it moves the loaded world time on by itself between loads. The same as the world time panel's
// own (WorldTimePanel.tsx); this one is shared by the top bar's market chips and the trading screen.

import { useEffect, useMemo, useState } from 'react';
import type { LiveClockView } from '../../api/src/contract';

export const TICK_MS = 10_000;   // minute precision is all the screens show

export function useElapsed(clock: LiveClockView | null): number {
  const loadedAt = useMemo(() => Date.now(), [clock]);
  const [now, setNow] = useState(loadedAt);
  useEffect(() => {
    if (!clock?.running) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [clock]);
  return Math.max(0, now - loadedAt);
}
