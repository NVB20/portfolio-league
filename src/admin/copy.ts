// Words and numbers for the admin page. Pure functions, no React, so every card says things the same way.

import type { AdminActionView, AdminOverview, AdminRunView, ClockView } from '../../api/src/contract';
import type { ClockOutcome } from './useAdmin';

// 1234 → "1,234"
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

// '2026-11-11' → '11.11.2026'
export function dateHe(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

// An ISO instant → its Israel date, '11.11.2026'.
export function instantDateHe(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  return dateHe(parts);
}

// A real moment, short: 'היום 14:02' when it was today in Israel, else the date.
export function realTimeLabel(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const israel = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
  if (israel(at) === israel(new Date(nowMs))) {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    return `היום ${time}`;
  }
  return instantDateHe(iso);
}

// When a player last had the app open (D-026): 'מחובר' within 2 minutes, then minutes ago, then today's
// time, then the date. `nowMs` is passed in so the function stays pure.
export function lastSeenLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'אף פעם';
  const minutes = Math.floor((nowMs - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'מחובר';
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  return realTimeLabel(iso, nowMs);
}

// 'סגירת תל אביב' / 'פתיחת ניו יורק'
export function runLabel(run: AdminRunView): string {
  return `${run.kind === 'open' ? 'פתיחת' : 'סגירת'} ${run.market === 'TASE' ? 'תל אביב' : 'ניו יורק'}`;
}

export const RUN_STATUS: Record<AdminRunView['status'], string> = {
  pending: 'ממתין',
  orders_done: 'הפקודות רצו, מעדכן שחקנים',
  done: 'הסתיים',
};

// What an admin did, in the log's words. Detail numbers are added when the action has them.
export function actionLabel(a: AdminActionView): string {
  const base = {
    clock_to_close: 'קידם לסגירה',
    clock_to_open: 'קידם לפתיחה הבאה',
    clock_start: 'הפעיל את השעון',
    clock_stop: 'עצר את השעון',
  }[a.action];
  const executed = typeof a.detail.ordersExecuted === 'number' ? a.detail.ordersExecuted : null;
  return executed !== null ? `${base} · ${count(executed)} פקודות בוצעו` : base;
}

// What the advance button will do: the API picks it the same way (a market open → its close, else the next open).
export function advanceLabel(clock: ClockView | null): string {
  return clock && (clock.markets.tase.isOpen || clock.markets.us.isOpen) ? 'קדם לסגירה' : 'קדם לפתיחה הבאה';
}

function runCounts(r: { events: number; ordersExecuted: number; ordersRejected: number }): string {
  if (r.events === 0) return 'לא עברו פתיחות או סגירות.';
  return `${count(r.events)} ${r.events === 1 ? 'אירוע רץ' : 'אירועים רצו'}: ${count(r.ordersExecuted)} פקודות בוצעו, ${count(r.ordersRejected)} נדחו.`;
}

// One line after a clock move, from the API's answer.
export function clockOutcomeLine(o: ClockOutcome): string {
  switch (o.move) {
    case 'advance': {
      const to = o.result.to;
      return `${o.result.kind === 'to_close' ? 'קודם לסגירה' : 'קודם לפתיחה'}: ${dateHe(to.date)} ${to.time}. ${runCounts(o.result)}`;
    }
    case 'start':
      return o.result.changed ? 'השעון הופעל ורץ עכשיו בזמן אמת.' : 'השעון כבר רץ.';
    case 'stop':
      return o.result.changed ? `השעון נעצר ב־${dateHe(o.result.at.date)} ${o.result.at.time}. ${runCounts(o.result)}` : 'השעון כבר עצור.';
  }
}

// A percentage from the API (already rounded to 1 decimal), or a dash when there is nobody to measure.
export function rateLabel(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

export function playersWord(n: number): string {
  return n === 1 ? 'שחקן' : 'שחקנים';
}

// Which markets are open right now, as one short line under the clock headline.
export function marketsLine(clock: ClockView): string {
  const { tase, us } = clock.markets;
  if (tase.isOpen && us.isOpen) return 'שני השווקים פתוחים.';
  if (tase.isOpen) return 'תל אביב פתוחה.';
  if (us.isOpen) return 'ניו יורק פתוחה.';
  return 'שני השווקים סגורים.';
}

export function clockSummary(clock: AdminOverview['clock']): string {
  if (!clock) return 'שעון העולם עוד לא הופעל. הוא מתחיל כשמריצים את npm run seed:world.';
  const end = clock.endsAt ? ` הוא נעצר ב־${dateHe(clock.endsAt.date)}, כשנגמרים המחירים.` : '';
  return clock.running
    ? `השעון רץ בזמן אמת. קידום מריץ את כל האירועים שבדרך, לפי הסדר, ולא חוזר אחורה.${end}`
    : `השעון עצור. הזמן בעולם לא זז עד שמנהל מקדם או מפעיל אותו.${end}`;
}

export function playersSummary(p: AdminOverview['players']): string {
  return `${count(p.joinedToday)} נרשמו היום · ${count(p.withHoldings)} מחזיקים ניירות · ${count(p.total - p.withHoldings)} רק במזומן.`;
}
