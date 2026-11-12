// Words, numbers and chart math for the monitoring page (/admin-monitoring, D-036). Pure functions with no
// React Native, so every card says things the same way and the rules can be tested without a screen.
// Usage counts real time and real Israel dates, like presence (D-026): the world clock plays no part here.

import type { AdminDbHealth, MonitoringRange, MonitoringTotals, UsageBucket, UsagePage } from '../../api/src/contract';
import { ils, WEEKDAY_LETTERS } from '../dashboard/format';
import { count, dateHe, playersWord } from './copy';

// The four player pages, in the top bar's order. The chart stacks them in this order from the baseline up and
// the legend lists them the same way, so a page keeps its place (and its color) everywhere on the page.
export const PAGES: readonly UsagePage[] = ['dashboard', 'trade', 'journal', 'leaderboard'];

// The top bar's tab names (TopBar.tsx), so the admin reads the same word the players see.
export const PAGE_LABEL: Record<UsagePage, string> = {
  dashboard: 'סקירה',
  trade: 'מסחר',
  journal: 'יומן',
  leaderboard: 'טבלה',
};

// The range switch in the page's first headline. It scopes the orders, the confirm popup and the pages list.
export const RANGES: { value: MonitoringRange; label: string }[] = [
  { value: 'today', label: 'היום' },
  { value: 'd7', label: '7 ימים' },
  { value: 'd30', label: '30 ימים' },
];

// The range inside a sentence: "12 פקודות נשלחו ב־7 הימים האחרונים".
export const RANGE_TEXT: Record<MonitoringRange, string> = {
  today: 'היום',
  d7: 'ב־7 הימים האחרונים',
  d30: 'ב־30 הימים האחרונים',
};

// The usage chart: one bar per day (the last 30) or per week (the last 12, Monday to Sunday like the game's week).
export type ChartUnit = 'day' | 'week';
export const UNITS: { value: ChartUnit; label: string }[] = [
  { value: 'day', label: 'לפי יום' },
  { value: 'week', label: 'לפי שבוע' },
];
export const UNIT_WINDOW: Record<ChartUnit, string> = { day: '30 הימים האחרונים', week: '12 השבועות האחרונים' };

// ---------- numbers ----------

// A length of time, short: "30 שנ׳", "45 ד׳", "3 ש׳ 12 ד׳". Rounded to the minute from one minute up. Some time
// that rounds to no seconds says so in words, so it doesn't read as none (a bare "<" flips in Hebrew text).
export function duration(ms: number): string {
  if (ms <= 0) return '0 ד׳';
  const seconds = Math.round(ms / 1000);
  if (seconds === 0) return 'פחות משנייה';
  if (seconds < 60) return `${seconds} שנ׳`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ד׳`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${count(h)} ש׳` : `${count(h)} ש׳ ${m} ד׳`;
}

// The same in whole words, for screen readers, which stumble over "ש׳".
export function durationSpoken(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} שניות`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} דקות`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${count(h)} שעות` : `${count(h)} שעות ו־${m} דקות`;
}

// part / whole, or null when there is no whole to measure against (nothing opened, nothing used).
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

// A share as "42%", or a dash when there is nothing to measure. A share that rounds down to 0 but isn't 0
// says "פחות מ־1%", so one back-out among hundreds of popups doesn't read as none.
export function percent(fraction: number | null): string {
  if (fraction === null) return '—';
  const pct = Math.round(fraction * 100);
  return pct === 0 && fraction > 0 ? 'פחות מ־1%' : `${pct}%`;
}

// 845 B, 12 KB, 4.2 MB, 1.3 GB (1024-based, like Postgres's pg_size_pretty).
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function bytes(n: number): string {
  let value = Math.max(0, n);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

// A round trip in milliseconds: one decimal under 10 ms, whole above. The unit is written next to it.
export function latencyNumber(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

// Average time per active player per bar: all the time divided by the players summed over the bars
// (player-days, or player-weeks). Null when nobody was active.
export function perPlayer(ms: number, playerBuckets: number): number | null {
  return playerBuckets > 0 ? ms / playerBuckets : null;
}

export function ordersSent(n: number): string {
  return n === 1 ? 'פקודה נשלחה' : 'פקודות נשלחו';
}

export function viewsWord(n: number): string {
  return n === 1 ? 'צפייה' : 'צפיות';
}

// ---------- dates ----------

// '2026-11-11' → '11.11'
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${d}.${m}`;
}

// The weekday of a calendar date (Sunday = 0). The date has no time zone, so read it as UTC midnight.
function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

// One bar's name. The API's buckets end on today and on this week, so the last bar is always the current one.
export function bucketLabel(start: string, unit: ChartUnit, isLast: boolean): string {
  if (unit === 'day') return isLast ? 'היום' : `יום ${WEEKDAY_LETTERS[weekdayOf(start)]} ${shortDate(start)}`;
  return isLast ? 'השבוע' : `שבוע מ־${shortDate(start)}`;
}

// A real moment as an Israel clock time with seconds, '14:02:31': the database card refreshes every 30 s.
export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

// How long the database server has been up: "12 ימים 4 ש׳", "5 ש׳ 12 ד׳".
export function uptime(startedAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 60_000));
  const days = Math.floor(minutes / 1440);
  if (days === 0) return duration(minutes * 60_000);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${count(days)} ${days === 1 ? 'יום' : 'ימים'}${hours > 0 ? ` ${hours} ש׳` : ''}`;
}

// ---------- the usage chart ----------

export type Segment = { page: UsagePage; ms: number };
// One bar: its pages from the baseline up, empty pages left out (a zero segment draws nothing).
export type Bar = { start: string; total: number; players: number; segments: Segment[] };
export type Stack = {
  bars: Bar[];
  top: number;            // the time at the top of the plot: a round value just above the tallest bar
  total: number;          // all the time in the shown bars
  playerBuckets: number;  // active players summed over the bars, for the average per player
};

// The chart's bars. `only` = a page picked in the legend: the bars show just that page and the scale follows it,
// so a small page isn't a sliver under a scale set by the big ones. Colors stay with the page either way.
export function stack(buckets: UsageBucket[], only: UsagePage | null): Stack {
  const pages = only ? [only] : PAGES;
  let total = 0;
  let playerBuckets = 0;
  let tallest = 0;
  const bars = buckets.map((b) => {
    const segments = pages.filter((p) => b.ms[p] > 0).map((p) => ({ page: p, ms: b.ms[p] }));
    const sum = segments.reduce((s, x) => s + x.ms, 0);
    total += sum;
    playerBuckets += b.players;
    tallest = Math.max(tallest, sum);
    return { start: b.start, total: sum, players: b.players, segments };
  });
  return { bars, top: axisTop(tallest), total, playerBuckets };
}

// All the time in the buckets, every page.
export function totalMs(buckets: UsageBucket[]): number {
  return buckets.reduce((s, b) => s + PAGES.reduce((t, p) => t + b.ms[p], 0), 0);
}

// The plot's top: the first round value at or above the tallest bar. Each one halves to a round value too
// (10 ד׳ → 5 ד׳, 4 ש׳ → 2 ש׳), so both gridlines read as clean times.
const TOP_MINUTES = [1, 2, 4, 6, 10, 20, 30, 40, 60];
const TOP_HOURS = [2, 4, 6, 8, 10, 20, 40, 60, 80, 100, 200, 400, 600, 800, 1000];
export function axisTop(tallestMs: number): number {
  const minutes = tallestMs / 60_000;
  for (const m of TOP_MINUTES) if (minutes <= m) return m * 60_000;
  const hours = minutes / 60;
  for (const h of TOP_HOURS) if (hours <= h) return h * 3_600_000;
  return Math.ceil(hours / 1000) * 1000 * 3_600_000;
}

// A bucket's players are everyone active in the app that day or week: the API has no players per page. So with
// one page picked in the legend, the bar's player count is left out (next to "רק יומן" it would read as the
// journal's players), and the average says it is per player active anywhere in the app.

// What one bar holds, for a screen reader.
export function bucketSpoken(bucket: UsageBucket, label: string, only: UsagePage | null): string {
  const pages = (only ? [only] : PAGES).filter((p) => bucket.ms[p] > 0);
  const total = pages.reduce((s, p) => s + bucket.ms[p], 0);
  const parts = pages.map((p) => `${PAGE_LABEL[p]} ${durationSpoken(bucket.ms[p])}`).join(', ');
  const players = only ? '' : `, ${count(bucket.players)} ${playersWord(bucket.players)}`;
  return `${label}: ${durationSpoken(total)}${players}${parts ? `. ${parts}` : ''}`;
}

// The line above the chart, for the picked bar.
export function barReadout(bar: Bar, only: UsagePage | null): string {
  return only ? duration(bar.total) : `${duration(bar.total)} · ${count(bar.players)} ${playersWord(bar.players)}`;
}

// The average tile's label, and the line under the chart that says how it is worked out.
export function averageLabel(unit: ChartUnit, only: UsagePage | null): string {
  const per = unit === 'day' ? 'ביום' : 'בשבוע';
  return only ? `ממוצע ב${PAGE_LABEL[only]} לשחקן פעיל באפליקציה ${per}` : `ממוצע לשחקן פעיל ${per}`;
}

export function averageNote(unit: ChartUnit, only: UsagePage | null): string {
  const each = unit === 'day' ? 'יום' : 'שבוע';
  const how = only
    ? `ממוצע = הזמן ב${PAGE_LABEL[only]} חלקי סכום השחקנים הפעילים באפליקציה בכל ${each}, גם מי שלא נכנס ל${PAGE_LABEL[only]}.`
    : `ממוצע = הזמן חלקי סכום השחקנים הפעילים בכל ${each}.`;
  return `${how} בטלפון נספר רק כשהאפליקציה פתוחה בחזית.`;
}

// ---------- sentences ----------

// What a usage card says when it has nothing to show: before anything was measured, or a range with no use.
// Never a zero dressed up as a measurement.
export function noUsageText(since: string | null, where: string): string {
  if (since === null) {
    return 'עוד אין נתוני שימוש. זמן, צפיות וחלון האישור נספרים מהרגע שהשחקנים פותחים את האפליקציה בגרסה שמודדת.';
  }
  return `אין שימוש ${where}. נמדד מאז ${dateHe(since)}.`;
}

// The first headline's sentence: who used the app in the range, and for how long.
export function usageSummary(t: MonitoringTotals, since: string | null, range: MonitoringRange): string {
  if (since === null) return noUsageText(null, '');
  const when = RANGE_TEXT[range];
  if (t.players === 0) return `אף שחקן לא השתמש באפליקציה ${when}. נמדד מאז ${dateHe(since)}.`;
  const who = t.players === 1 ? 'שחקן אחד השתמש' : `${count(t.players)} שחקנים השתמשו`;
  return `${who} באפליקציה ${when}, ${duration(t.ms)} בסך הכול. נמדד מאז ${dateHe(since)}.`;
}

// Under the confirm-popup numbers: what "backed out" means, and why sent can be more than opened.
export function confirmNote(c: MonitoringTotals['confirms'], sent: number, range: MonitoringRange): string {
  const base =
    'פקודה שנשלחה אי אפשר לבטל, אז "חזרו" = סגרו את החלון בלי לשלוח: חזור, לחיצה מחוץ לחלון, שינוי בפקודה או יציאה מהמסך. "נשלחו" נספרות מטבלת הפקודות.';
  // First, so 0 openings next to orders sent through the popup is explained, not called "nobody opened it".
  if (sent > c.opened) return `${base} יש יותר פקודות מפתיחות: חלקן נשלחו לפני שהמדידה התחילה, או מגרסה ישנה של האפליקציה.`;
  if (c.opened === 0) return `אף אחד לא פתח את החלון ${RANGE_TEXT[range]}. ${base}`;
  return base;
}

// ---------- the stop-loss card (D-037, D-041) ----------

// Under the stop-loss numbers: where they come from, and what the stops that fired in the range did.
export function stopNote(s: MonitoringTotals['stops'], range: MonitoringRange): string {
  const base = 'מטבלת הפקודות, לפי זמן השליחה האמיתי. "הופעלו" = מכירות שסטופ יצר כשהמחיר הגיע אליו בפתיחה או בסגירה. "הזזות" = שינויי מחיר של סטופ פעיל, מהכרטיסים ומהיומן.';
  if (s.fired === 0) return base;
  const result = s.firedPnlIls < 0 ? `בהפסד של ${ils(-s.firedPnlIls)}` : `ברווח של ${ils(s.firedPnlIls)}`;
  return `${base} המכירות שלהם ${RANGE_TEXT[range]} נסגרו ${result} בסך הכול.`;
}

// ---------- the database card ----------

// Past any of these the database light turns amber and says why. Rules of thumb, not alarms.
export const DB_WARN = { latencyMs: 250, connectionsShare: 0.8, longQuerySec: 30, cacheHitPct: 90 };

export function dbStatus(h: AdminDbHealth): { variant: 'up' | 'warn'; label: string } {
  const c = h.server.connections;
  if (h.pool.waiting > 0) return { variant: 'warn', label: `${count(h.pool.waiting)} מחכים לחיבור` };
  if (c.max > 0 && c.total >= c.max * DB_WARN.connectionsShare) return { variant: 'warn', label: 'קרוב לתקרת החיבורים' };
  if (h.server.longestQuerySec !== null && h.server.longestQuerySec >= DB_WARN.longQuerySec) return { variant: 'warn', label: 'שאילתה ארוכה רצה' };
  if (h.latencyMs >= DB_WARN.latencyMs) return { variant: 'warn', label: 'תגובה איטית' };
  if (h.server.cacheHitPct !== null && h.server.cacheHitPct < DB_WARN.cacheHitPct) return { variant: 'warn', label: 'הרבה קריאות מהדיסק' };
  return { variant: 'up', label: 'תקין' };
}

// The database card after a failed check (useAdminDb). Most failures mean the database or the server can't be
// reached. `denied` (401/403) means the server refused this caller, which it decided by asking the database, so
// it must not read as the database being down.
export function dbFailure(error: string, denied: boolean): { title: string; chip: string; text: string; note: string; page: string } {
  return denied
    ? {
        title: 'לא נבדק.',
        chip: 'אין הרשאה',
        text: `הבדיקה נדחתה: ${error}.`,
        note: 'כנראה שהחשבון כבר לא מנהל, או שההתחברות פגה. רעננו את העמוד או התחברו מחדש. המסד עצמו ענה: בדיקת ההרשאה עוברת דרכו.',
        page: `אין הרשאה לעמודי הניהול · ${error}`,
      }
    : {
        title: 'לא עונה.',
        chip: 'אין חיבור',
        text: `אין חיבור למסד או לשרת. ${error}.`,
        note: 'הבדיקה הבאה בעוד 30 שניות. בלי מסד גם בדיקת ההרשאה של המנהל נכשלת, לכן אין כאן מספרים.',
        page: `אין חיבור למסד או לשרת · ${error}`,
      };
}

// Connections the API's pool holds and is using right now (the rest of the pool sits idle).
export function poolInUse(pool: AdminDbHealth['pool']): number {
  return Math.max(0, pool.total - pool.idle);
}

// The longest query running right now, other than the check itself.
export function queryTime(sec: number | null): string {
  if (sec === null) return 'אין שאילתה רצה';
  if (sec < 1) return 'פחות משנייה';
  return duration(sec * 1000);
}

// A table's row count is Postgres's estimate (reltuples), which is -1 until the table was first analyzed.
export function rowsText(rows: number): string {
  if (rows < 0) return 'שורות: עוד לא נספרו';
  const n = Math.round(rows);
  return n === 1 ? 'שורה אחת' : `כ־${count(n)} שורות`;
}

export function cacheText(pct: number | null): string {
  return pct === null ? 'עוד אין קריאות' : `${pct.toFixed(1)}%`;
}
