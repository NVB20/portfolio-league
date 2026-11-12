// Real ms since this clock was loaded, ticking while the admin has the clock running (D-017). With liveTime()
// (liveClock.ts) it moves the loaded world time on by itself between loads. Shared by the top bar's market chips,
// the world time panel, the trading screen, the journal and the leaderboard.
//
// The load time is taken in the effect, not during render, and each tick remembers which clock it measured: a new
// clock reads 0 until its own first tick, with no render that pairs the new clock with the old clock's elapsed time.

import { useEffect, useState } from 'react';
import type { LiveClockView } from '../../api/src/contract';

export const TICK_MS = 10_000;   // minute precision is all the screens show

export function useElapsed(clock: LiveClockView | null): number {
  const [tick, setTick] = useState<{ clock: LiveClockView | null; ms: number }>({ clock, ms: 0 });
  useEffect(() => {
    if (!clock?.running) return;
    const loadedAt = Date.now();
    const id = setInterval(() => setTick({ clock, ms: Math.max(0, Date.now() - loadedAt) }), TICK_MS);
    return () => clearInterval(id);
  }, [clock]);
  return tick.clock === clock ? tick.ms : 0;
}
