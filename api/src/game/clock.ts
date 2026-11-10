// The world clock's moves, as pure functions (D-017).
//   Move 1 "to the close":     a market is open   -> jump to the earliest close of an open market
//   Move 2 "to the next open": no market is open  -> jump to the earliest open of either market
//   Move 3 running:            nobody jumps       -> world time runs at real speed; days on which neither
//                                                    market opens are skipped (they take no real time)
// Every move ends with the list of opens and closes it passed: the runner executes orders and saves
// snapshots at each one, in order. The clock never goes past `end` (the last day with prices).

import { addDays, ISRAEL, zonedParts, zonedToInstant } from './time.js';
import {
  type Calendar,
  isMarketOpen,
  type MarketEvent,
  MARKETS,
  nextOpen,
  NO_CLOSURES,
  sessionOn,
} from './marketHours.js';

const DAY_MS = 86_400_000;
const MAX_DAYS_SCANNED = 400;   // a guard against a bad calendar or a far `to`, not a real limit

// Does either market open on this Israel calendar date?
export function isTradingDay(date: string, calendar: Calendar = NO_CLOSURES): boolean {
  return MARKETS.some((m) => sessionOn(m, date, calendar) !== null);
}

function midnightAfter(instant: Date): Date {
  const { date } = zonedParts(instant, ISRAEL);
  return zonedToInstant(addDays(date, 1), 0, ISRAEL);
}

// Every open and close strictly after `from` and at or before `to`, in time order.
// At the same instant a close comes before an open, so a fill at one market's close never waits on the other.
export function eventsBetween(from: Date, to: Date, calendar: Calendar = NO_CLOSURES): MarketEvent[] {
  if (to <= from) return [];
  const events: MarketEvent[] = [];
  const last = zonedParts(to, ISRAEL).date;
  let day = zonedParts(from, ISRAEL).date;
  for (let i = 0; i <= MAX_DAYS_SCANNED && day <= last; i++, day = addDays(day, 1)) {
    for (const market of MARKETS) {
      const s = sessionOn(market, day, calendar);
      if (!s) continue;
      for (const kind of ['open', 'close'] as const) {
        const at = zonedToInstant(day, kind === 'open' ? s.openMin : s.closeMin, ISRAEL);
        if (at > from && at <= to) events.push({ market, kind, day, at });
      }
    }
  }
  return events.sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'close' ? -1 : 1),
  );
}

export type Jump = { kind: 'to_close' | 'to_open'; to: Date };

// Where an admin jump goes from `now`. Move 1 if a market is open, otherwise move 2.
// Capped at `end`; null when the clock is already there.
export function jumpTarget(now: Date, end: Date, calendar: Calendar = NO_CLOSURES): Jump | null {
  if (now >= end) return null;
  const open = MARKETS.filter((m) => isMarketOpen(m, now, calendar));
  let jump: Jump;
  if (open.length > 0) {
    const { date } = zonedParts(now, ISRAEL);
    const closes = open.map((m) => zonedToInstant(date, sessionOn(m, date, calendar)!.closeMin, ISRAEL));
    jump = { kind: 'to_close', to: new Date(Math.min(...closes.map((d) => d.getTime()))) };
  } else {
    const opens = MARKETS.map((m) => nextOpen(m, now, calendar).at.getTime());
    jump = { kind: 'to_open', to: new Date(Math.min(...opens)) };
  }
  return jump.to > end ? { ...jump, to: end } : jump;
}

// Has the world moved past what the admin saw? `seen` is the world time the admin page showed when the admin
// clicked advance. Every jump runs at least the open or close it lands on, so events_through > seen means a
// jump already went through since (a retry whose first answer was lost) or the ticker ran an event meanwhile:
// either way the click was about a world that is gone, and jumping again would skip a session for every
// player. A running clock that merely ticked on, with no event in between, has not moved in this sense.
export function movedSince(seen: Date, eventsThrough: Date | null): boolean {
  return eventsThrough !== null && eventsThrough > seen;
}

// The world_clock row that "now" is computed from (D-017, D-021).
export type ClockState = {
  nowAt: Date;                 // the world time the clock was last set to
  realAt: Date;                // the real time it was set
  running: boolean;
  endsAt: Date | null;         // the clock never passes it; null = no end
  eventsThrough: Date | null;  // the latest event the runner has started
};

const NO_END = new Date(8.64e15);   // the latest Date there is

// The world's "now": the clock time, but never before the latest event the runner has started.
// During an admin jump the runner starts the 17:30 close before the clock row moves. An order sent in that
// moment must go to the next open, not into a close that is already running, and the screens must show the
// same time the order rules use. The screens, order sending and the runner all call this one function.
export function worldNow(row: ClockState, realNow: Date, calendar: Calendar): Date {
  const clock = row.running
    ? runForward(row.nowAt, realNow.getTime() - row.realAt.getTime(), row.endsAt ?? NO_END, calendar)
    : row.nowAt;
  return row.eventsThrough !== null && row.eventsThrough > clock ? row.eventsThrough : clock;
}

// Move 3: the world time after `realElapsedMs` of real time has passed since `worldAt`.
// Real time is spent only on days when a market opens. On reaching a day when neither does, the clock
// moves straight to midnight of the next trading day. Capped at `end`.
export function runForward(worldAt: Date, realElapsedMs: number, end: Date, calendar: Calendar = NO_CLOSURES): Date {
  let t = worldAt;
  let left = Math.max(0, realElapsedMs);
  for (let i = 0; i <= MAX_DAYS_SCANNED + left / DAY_MS; i++) {
    if (t >= end) return end;
    const { date } = zonedParts(t, ISRAEL);
    if (!isTradingDay(date, calendar)) {
      t = midnightAfter(t);
      continue;
    }
    const dayEnd = midnightAfter(t);
    const room = dayEnd.getTime() - t.getTime();
    if (left < room) {
      const r = new Date(t.getTime() + left);
      return r > end ? end : r;
    }
    left -= room;
    t = dayEnd;
  }
  return t > end ? end : t;
}
