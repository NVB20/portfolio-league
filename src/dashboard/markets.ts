// Each market's status, shown separately (D-022): the top bar's two chips, and the dashboard's line on the days
// when only one market trades. Pure: reads the clock's `markets` as the API sent them, moved on to the live
// time when one is given (src/dashboard/liveClock.ts, D-017).

import type { ClockView, LiveClockView, MarketSession } from '../../api/src/contract';
import { isOpenAt, liveTime, type LiveTime } from './liveClock';

type Markets = ClockView['markets'];
export type MarketKey = keyof Markets;

const SHORT: Record<MarketKey, string> = { tase: 'ת״א', us: 'ניו יורק' };
const FULL: Record<MarketKey, string> = { tase: 'תל אביב', us: 'ניו יורק' };
const KEYS: MarketKey[] = ['tase', 'us'];

// state: the open/closed word, shown next to the label, so the state never rests on the dot's colour alone.
export type MarketChip = { key: MarketKey; label: string; open: boolean; state: string; a11y: string };

// TASE first, then New York: open = trading right now. With `t` (the live time), at that time, the way the
// world time panel shows it; without, as loaded.
export function marketChips(markets: Markets, t?: LiveTime): MarketChip[] {
  return KEYS.map((key) => {
    const open = t ? isOpenAt(markets[key], t) : markets[key].isOpen;
    const state = open ? 'פתוחה' : 'סגורה';
    return { key, label: SHORT[key], open, state, a11y: `${FULL[key]} ${state}` };
  });
}

const MINUTE = 60_000;

// The clock has moved past what the loaded data describes: a market opened or closed (so an order sent now runs
// at another price and time, and the runner may have moved cash and marks), a new world day began, or the clock
// reached its end. Compared with the loaded moment itself, so a stopped clock or one already at its end never counts.
//
// liveTime() counts from clock.time, which leaves out the seconds of clock.at; they are added back here (Israel's
// offset is whole hours, so they are the same in UTC), so an open or close is seen within one tick, not up to a
// minute late. The end is compared on the exact instants for the same reason.
export function marketsChanged(clock: LiveClockView, elapsedMs: number): boolean {
  const seconds = ((Date.parse(clock.at) % MINUTE) + MINUTE) % MINUTE;
  const left = clock.endsAt ? Date.parse(clock.endsAt.at) - Date.parse(clock.at) : Infinity;
  const ended = (ms: number) => (clock.running ? ms : 0) >= left;
  const then = liveTime(clock, seconds);
  const now = liveTime(clock, elapsedMs + seconds);
  if (now.dayOffset !== then.dayOffset || ended(elapsedMs) !== ended(0)) return true;
  return KEYS.some((k) => isOpenAt(clock.markets[k], now) !== isOpenAt(clock.markets[k], then));
}

// 'היום רק ניו יורק פתוחה · ת״א סגורה: פסח' when one market has a session today and the other is closed all
// day (a holiday or the weekend). null on a normal day, or when both are closed.
export function oneMarketToday(markets: Markets): string | null {
  const trades = KEYS.filter((k) => markets[k].session !== null);
  const closed = KEYS.filter((k) => closedAllDay(markets[k]));
  if (trades.length !== 1 || closed.length !== 1) return null;
  const why = closedReason(markets[closed[0]]);
  return `היום רק ${SHORT[trades[0]]} פתוחה · ${SHORT[closed[0]]} סגורה${why ? `: ${why}` : ''}`;
}

function closedAllDay(m: MarketSession): boolean {
  return m.session === null && (m.state === 'holiday' || m.state === 'weekend');
}

// The calendar's reason ('פסח', 'הבורסה בת״א סגורה בימי שישי עד ינואר 2026'); the weekend has none.
function closedReason(m: MarketSession): string | null {
  return m.reason ?? (m.state === 'weekend' ? 'סוף שבוע' : null);
}
