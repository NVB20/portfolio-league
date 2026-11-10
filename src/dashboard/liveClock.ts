// The world clock between two loads of the dashboard. While the admin has it running, world time moves at
// real speed (D-017), so the screen moves it on by itself instead of asking the API every minute.
// Pure: the real time elapsed since the load is passed in.
//
// Known limit: the API skips days on which neither market opens. If the screen stays open across a world
// midnight, the local count shows the next calendar day until the next load.

import type { LiveClockView, MarketSession, WorldTime } from '../../api/src/contract';
import { dayLabel, hhmm } from './format';

const DAY_MIN = 24 * 60;

export type LiveTime = {
  weekday: number;
  minutes: number;     // Israel wall clock, minutes since midnight
  dayOffset: number;   // whole days past the loaded date (0 = still the same day)
  ended: boolean;      // reached the admin's end time: the clock stops there for good
};

export function liveTime(clock: LiveClockView, elapsedMs: number): LiveTime {
  let ms = clock.running ? Math.max(0, elapsedMs) : 0;
  let ended = false;
  if (clock.endsAt) {
    const left = Math.max(0, Date.parse(clock.endsAt.at) - Date.parse(clock.at));
    if (ms >= left) {
      ms = left;
      ended = true;
    }
  }
  const total = minutesOf(clock.time) + Math.floor(ms / 60_000);
  const dayOffset = Math.floor(total / DAY_MIN);
  return { weekday: (clock.weekday + dayOffset) % 7, minutes: total % DAY_MIN, dayOffset, ended };
}

export type ClockStatus = 'running' | 'stopped' | 'ended';

export function clockStatus(clock: LiveClockView, t: LiveTime): ClockStatus {
  if (t.ended) return 'ended';
  return clock.running ? 'running' : 'stopped';
}

// One market's line at the live time:
// 'פתוחה עד 17:30' / 'נפתחת 16:30' / 'נסגרה 17:30 · נפתחת יום ה׳ 10:00' / 'סגורה · פסח · נפתחת יום ב׳ 10:00'
export function marketLine(m: MarketSession, t: LiveTime, loadedDate: string): string {
  const s = t.dayOffset === 0 ? m.session : null;
  // Opens after today. (A nextOpen on the loaded date is today's open, already covered by the session.)
  const later = m.nextOpen && m.nextOpen.date !== loadedDate ? ` · נפתחת ${when(m.nextOpen)}` : '';

  if (s) {
    if (t.minutes < s.openMin) return `נפתחת ${hhmm(s.openMin)}`;
    if (t.minutes < s.closeMin) return `פתוחה עד ${hhmm(s.closeMin)}`;
    return `נסגרה ${hhmm(s.closeMin)}${later}`;
  }
  if (t.dayOffset > 0) return m.nextOpen ? `נפתחת ${when(m.nextOpen)}` : 'סגורה';
  return `סגורה${m.reason ? ` · ${m.reason}` : ''}${later}`;
}

export function isOpenAt(m: MarketSession, t: LiveTime): boolean {
  const s = t.dayOffset === 0 ? m.session : null;
  return !!s && t.minutes >= s.openMin && t.minutes < s.closeMin;
}

// 'יום ו׳ 20.11 · 09:59': where the admin's clock stops.
export function endLabel(end: WorldTime): string {
  const [, mm, dd] = end.date.split('-');
  return `${dayLabel(end.weekday)} ${dd}.${mm} · ${end.time}`;
}

function when(t: WorldTime): string {
  return `${dayLabel(t.weekday)} ${t.time}`;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
