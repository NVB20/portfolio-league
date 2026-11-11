// The monitoring page's pure helpers (src/admin/monitoring.ts, D-036): the sentences that explain the numbers,
// the chart's labels with one page picked in the legend, and the database card's words. No database, no React.
// Loaded at run time, not imported, for the reason written at the top of app-dashboard.test.ts: to this package's
// type check every file under src/ is CommonJS. Their shapes are written out below from the shared contract.

import { describe, expect, it } from 'vitest';
import type { MonitoringTotals, UsageBucket, UsagePage } from '../src/contract.js';

const app = <T>(path: string): Promise<T> => import(new URL(`../../src/${path}.ts`, import.meta.url).href) as Promise<T>;

type ChartUnit = 'day' | 'week';
type Bar = { start: string; total: number; players: number; segments: { page: UsagePage; ms: number }[] };

const { averageLabel, averageNote, barReadout, bucketSpoken, confirmNote, dbFailure, perPlayer, rowsText, stack } = await app<{
  averageLabel(unit: ChartUnit, only: UsagePage | null): string;
  averageNote(unit: ChartUnit, only: UsagePage | null): string;
  barReadout(bar: Bar, only: UsagePage | null): string;
  bucketSpoken(bucket: UsageBucket, label: string, only: UsagePage | null): string;
  confirmNote(c: MonitoringTotals['confirms'], sent: number, range: 'today' | 'd7' | 'd30'): string;
  dbFailure(error: string, denied: boolean): { title: string; chip: string; text: string; note: string; page: string };
  perPlayer(ms: number, playerBuckets: number): number | null;
  rowsText(rows: number): string;
  stack(buckets: UsageBucket[], only: UsagePage | null): { bars: Bar[]; top: number; total: number; playerBuckets: number };
}>('admin/monitoring');

const MORE_ORDERS = 'יש יותר פקודות מפתיחות';
const NOBODY = 'אף אחד לא פתח את החלון';

describe('confirmNote', () => {
  it('orders sent with no openings measured: explains why, never "nobody opened it"', () => {
    const note = confirmNote({ opened: 0, backed: 0 }, 3, 'today');
    expect(note).toContain(MORE_ORDERS);
    expect(note).not.toContain(NOBODY);
  });

  it('nothing opened and nothing sent: nobody opened it', () => {
    const note = confirmNote({ opened: 0, backed: 0 }, 0, 'd7');
    expect(note).toContain(NOBODY);
    expect(note).not.toContain(MORE_ORDERS);
  });

  it('more orders than openings: explains why; otherwise just what the words mean', () => {
    expect(confirmNote({ opened: 2, backed: 0 }, 5, 'd30')).toContain(MORE_ORDERS);
    const plain = confirmNote({ opened: 5, backed: 2 }, 3, 'd30');
    expect(plain).not.toContain(MORE_ORDERS);
    expect(plain).not.toContain(NOBODY);
  });
});

describe('the usage chart with one page picked', () => {
  const zeros = { dashboard: 0, trade: 0, journal: 0, leaderboard: 0 };
  // 10 players a day, each 10 minutes on the dashboard; 1 minute of journal a day in all.
  const buckets: UsageBucket[] = Array.from({ length: 30 }, (_, i) => ({
    start: `2026-10-${String(13 + i).padStart(2, '0')}`,
    players: 10,
    ms: { ...zeros, dashboard: 100 * 60_000, journal: 60_000 },
  }));

  it('the bar line leaves the app-wide player count out, since it is not the page\'s', () => {
    const all = stack(buckets, null).bars[0];
    const journal = stack(buckets, 'journal').bars[0];
    expect(barReadout(all, null)).toContain('10 שחקנים');
    expect(barReadout(journal, 'journal')).toBe('1 ד׳');
    expect(bucketSpoken(buckets[0], 'היום', null)).toContain('10 שחקנים');
    expect(bucketSpoken(buckets[0], 'היום', 'journal')).not.toContain('שחקנים');
  });

  it('the average says it is per player active anywhere in the app', () => {
    const s = stack(buckets, 'journal');
    expect(perPlayer(s.total, s.playerBuckets)).toBe(6_000);   // 30 min / 300 player-days: the label must say so
    expect(averageLabel('day', null)).toBe('ממוצע לשחקן פעיל ביום');
    expect(averageLabel('day', 'journal')).toBe('ממוצע ביומן לשחקן פעיל באפליקציה ביום');
    expect(averageLabel('week', 'trade')).toBe('ממוצע במסחר לשחקן פעיל באפליקציה בשבוע');
    expect(averageNote('day', 'journal')).toContain('גם מי שלא נכנס ליומן');
    expect(averageNote('week', null)).not.toContain('גם מי שלא');
  });
});

describe('the database card', () => {
  it('a refused check (401/403) is not "no connection"', () => {
    const denied = dbFailure('השרת ענה 403 · admins only', true);
    const down = dbFailure('השרת לא ענה תוך 10 שניות', false);
    expect(down.chip).toBe('אין חיבור');
    expect(down.text).toContain('אין חיבור למסד או לשרת');
    expect(down.page).toContain('אין חיבור למסד או לשרת');
    for (const words of [denied.title, denied.chip, denied.text, denied.note, denied.page]) {
      expect(words).not.toContain('אין חיבור');
    }
    expect(denied.chip).toBe('אין הרשאה');
    expect(denied.text).toContain('403');
  });

  it('a never-analyzed table (-1) says its rows are not counted yet; 0 rows is a real 0', () => {
    expect(rowsText(-1)).toBe('שורות: עוד לא נספרו');
    expect(rowsText(0)).toBe('כ־0 שורות');
    expect(rowsText(1)).toBe('שורה אחת');
    expect(rowsText(1234)).toBe('כ־1,234 שורות');
  });
});
