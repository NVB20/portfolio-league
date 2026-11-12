// The trade journal screen's pure helpers (src/journal/journal.ts, D-035): the sentences, each row's texts, the
// columns per width, and paging. No database, no React.
// The app file is an ES module for this NodeNext check because of src/journal/package.json ("type": "module").

import { describe, expect, it } from 'vitest';
import type { TradeJournalRow, TradeJournalView, WorldTime } from '../src/contract.js';
import {
  DUE_RETRY_MS, dueRetryMs, emptyLine, filterLabel, headline, ils, journalPath, MAX_DUE_TRIES, mergePage, orderSize,
  parseFilter, price, rate, realizedLine, reloadLimit, rowView, signedIls, tableColumns, tableHeadline, TABLE_FULL,
  TABLE_MID, when, winLossLine,
} from '../../src/journal/journal.js';

// Wednesday 11.11.2026, 12:40 Israel time.
const CLOCK = { at: '2026-11-11T10:40:00.000Z', date: '2026-11-11' };
const t = (at: string, date: string, weekday: number, time: string): WorldTime => ({ at, date, weekday, time });
const TODAY_1630 = t('2026-11-11T14:30:00.000Z', '2026-11-11', 3, '16:30');
const MON_1730 = t('2026-11-09T15:30:00.000Z', '2026-11-09', 1, '17:30');

const row = (o: Partial<TradeJournalRow> = {}): TradeJournalRow => ({
  id: '1',
  symbol: 'TEVA',
  nameHe: 'טבע',
  market: 'TASE',
  currency: 'ILS',
  side: 'buy',
  status: 'pending',
  amountIls: 10000,
  units: null,
  priceType: 'open',
  placedAt: t('2026-11-11T10:30:00.000Z', '2026-11-11', 3, '12:30'),
  executesAt: TODAY_1630,
  fill: null,
  reject: null,
  origin: 'player',
  stopPrice: null,
  stop: null,
  ...o,
});

const STATS = { wins: 0, losses: 0, even: 0, winRatePct: null, realizedPnlIls: 0, avgWinIls: null, avgLossIls: null };
const COUNTS = { all: 0, pending: 0, executed: 0, rejected: 0 };
const view = (o: Partial<TradeJournalView> = {}): TradeJournalView => ({
  clock: null,
  filter: 'all',
  period: 'week',
  stats: STATS,
  counts: COUNTS,
  reservedCash: 0,
  rows: [],
  hasMore: false,
  due: false,
  ...o,
});

describe('numbers', () => {
  it('writes ₪ with agorot only when there are some, gains with a sign, prices in their own currency', () => {
    expect(ils(5000)).toBe('₪5,000');
    expect(ils(1234.5)).toBe('₪1,234.50');
    expect(ils(-300.25)).toBe('−₪300.25');
    expect(signedIls(1200.5)).toBe('+₪1,200.50');
    expect(signedIls(-300.25)).toBe('−₪300.25');
    expect(signedIls(0)).toBe('₪0');
    expect(price(190.025, 'ILS')).toBe('₪190.03');
    expect(price(180, 'USD')).toBe('$180.00');
    expect(rate(50)).toBe('50%');
    expect(rate(66.7)).toBe('66.7%');
  });

  it('a buy is a ₪ amount, a sell a number of units (D-018)', () => {
    expect(orderSize({ side: 'buy', amountIls: 10000, units: null })).toBe('₪10,000');
    expect(orderSize({ side: 'sell', amountIls: null, units: 12.5 })).toBe('12.5 יח׳');
    expect(orderSize({ side: 'sell', amountIls: null, units: 59.40766 })).toBe('59.4077 יח׳');
  });

  it('says "today" for the world clock’s date, the day and date otherwise', () => {
    expect(when(TODAY_1630, '2026-11-11')).toBe('היום 16:30');
    expect(when(MON_1730, '2026-11-11')).toBe('יום ב׳ 9.11, 17:30');
    expect(when(MON_1730, null)).toBe('יום ב׳ 9.11, 17:30');
  });
});

describe('the filter', () => {
  it('reads ?filter= from the URL, "all" for anything unknown', () => {
    expect(parseFilter('pending')).toBe('pending');
    expect(parseFilter(['rejected', 'all'])).toBe('rejected');
    expect(parseFilter('open')).toBe('all');
    expect(parseFilter(undefined)).toBe('all');
  });

  it('labels each option with its count', () => {
    expect(filterLabel('pending', { all: 6, pending: 1, executed: 4, rejected: 1 })).toBe('ממתינות 1');
    expect(filterLabel('all', { all: 1284, pending: 0, executed: 0, rejected: 0 })).toBe('הכל 1,284');
  });
});

describe('sentences', () => {
  it('before any order: what fills the page', () => {
    expect(headline(view())).toEqual({ lead: 'עוד אין פקודות השבוע.', accent: 'פקודה ששולחים מופיעה כאן מיד.' });
    expect(headline(view({ period: 'all' })).lead).toBe('עוד לא שלחת פקודות.');
  });

  it('orders but no sell yet: how many, and when the results come', () => {
    expect(headline(view({ counts: { ...COUNTS, all: 3, pending: 1 } }))).toEqual({
      lead: '3 פקודות השבוע.',
      accent: 'התוצאות יופיעו אחרי המכירה הראשונה.',
    });
    expect(headline(view({ counts: { ...COUNTS, all: 1 } })).lead).toBe('פקודה אחת השבוע.');
  });

  it('with sells: how many made money, then the realized gain or loss', () => {
    const stats = { ...STATS, wins: 7, losses: 3, even: 1, winRatePct: 70, realizedPnlIls: 12340.5 };
    expect(headline(view({ stats, counts: { ...COUNTS, all: 20 } }))).toEqual({
      lead: '7 מתוך 11 מכירות ברווח.',
      accent: 'רווח ממומש +₪12,340.50 השבוע.',
    });
    expect(realizedLine({ period: 'all', stats: { ...stats, realizedPnlIls: -300 } })).toBe('הפסד ממומש ₪300 מתחילת המשחק.');
    expect(realizedLine({ period: 'week', stats: { ...stats, realizedPnlIls: 0 } })).toBe('רווח ממומש ₪0 השבוע.');
  });

  it('one sell: says how it closed', () => {
    const counts = { ...COUNTS, all: 2 };
    expect(headline(view({ counts, stats: { ...STATS, wins: 1, winRatePct: 100, realizedPnlIls: 50 } })).lead).toBe('המכירה שלך נסגרה ברווח.');
    expect(headline(view({ counts, stats: { ...STATS, losses: 1, winRatePct: 0, realizedPnlIls: -50 } })).lead).toBe('המכירה שלך נסגרה בהפסד.');
    expect(headline(view({ counts, stats: { ...STATS, even: 1 } })).lead).toBe('המכירה שלך נסגרה ב־₪0.');
  });

  it('wins and losses, and the ₪0 sells only when there are some', () => {
    expect(winLossLine({ wins: 7, losses: 4, even: 0 })).toBe('7 ברווח · 4 בהפסד');
    expect(winLossLine({ wins: 7, losses: 4, even: 1 })).toBe('7 ברווח · 4 בהפסד · 1 ב־₪0');
  });

  it('the table’s headline counts the orders and the ones still waiting', () => {
    expect(tableHeadline(view({ counts: { all: 6, pending: 0, executed: 5, rejected: 1 } }))).toEqual({ lead: '6 פקודות השבוע.', accent: null });
    expect(tableHeadline(view({ counts: { all: 6, pending: 1, executed: 4, rejected: 1 } })).accent).toBe('אחת מחכה לביצוע.');
    expect(tableHeadline(view({ period: 'all', counts: { all: 9, pending: 3, executed: 6, rejected: 0 } }))).toEqual({
      lead: '9 פקודות מתחילת המשחק.',
      accent: '3 מחכות לביצוע.',
    });
    expect(tableHeadline(view()).lead).toBe('אין פקודות השבוע.');
  });

  it('an empty table says what would be there', () => {
    expect(emptyLine('pending', 'week')).toContain('אין פקודות ממתינות');
    expect(emptyLine('rejected', 'all')).toBe('אין פקודות שנדחו מתחילת המשחק.');
    expect(emptyLine('executed', 'week')).toBe('עוד אין פקודות שבוצעו השבוע.');
  });
});

describe('rowView', () => {
  it('a waiting order: when it runs and at which price', () => {
    const v = rowView(row(), CLOCK);
    expect(v).toMatchObject({ side: 'קנייה', size: '₪10,000', placed: 'היום 12:30', status: 'ממתינה', tone: 'warn', price: null, amount: null, pnl: null });
    expect(v.detail).toBe('תבוצע היום 16:30 · שער פתיחה');
    expect(v.a11y).toBe('קנייה TEVA, ₪10,000. ממתינה: תבוצע היום 16:30 · שער פתיחה.');
  });

  it('a waiting order whose time has passed is being run', () => {
    const v = rowView(row({ executesAt: t('2026-11-11T08:00:00.000Z', '2026-11-11', 3, '10:00') }), CLOCK);
    expect(v.status).toBe('בביצוע');
    expect(v.detail).toBe('רצה עכשיו · שער פתיחה');
  });

  it('a filled sell: the fill, the rate for a US stock, and the result', () => {
    const v = rowView(
      row({
        symbol: 'NVDA', market: 'US', currency: 'USD', side: 'sell', status: 'executed', amountIls: null, units: 5,
        priceType: 'close', executesAt: MON_1730,
        fill: { price: 180, fxRate: 3.72, units: 5, ils: 3348, realizedPnlIls: -300.25 },
      }),
      CLOCK,
    );
    expect(v).toMatchObject({
      side: 'מכירה', size: '5 יח׳', status: 'בוצעה', tone: 'ghost', detail: 'יום ב׳ 9.11, 17:30 · שער סגירה',
      price: '$180.00', fx: 'לפי ₪3.72 לדולר', amount: '₪3,348', pnl: '−₪300.25', pnlTone: 'down',
    });
    expect(v.a11y).toContain('הפסד ₪300.25.');
  });

  it('a filled buy has no result; a sell at ₪0 is neutral', () => {
    const buy = rowView(row({ status: 'executed', fill: { price: 130, fxRate: null, units: 76.9, ils: 10000, realizedPnlIls: null } }), CLOCK);
    expect(buy).toMatchObject({ price: '₪130.00', fx: null, amount: '₪10,000', pnl: null, pnlTone: 'ghost' });
    const even = rowView(row({ side: 'sell', amountIls: null, units: 1, status: 'executed', fill: { price: 130, fxRate: null, units: 1, ils: 130, realizedPnlIls: 0 } }), CLOCK);
    expect(even).toMatchObject({ pnl: '₪0', pnlTone: 'ghost' });
  });

  it('a rejected order shows the server’s reason', () => {
    const v = rowView(row({ status: 'rejected', reject: { code: 'OVER_LIMIT', reason: 'מעל 20% מהתיק' } }), CLOCK);
    expect(v).toMatchObject({ status: 'נדחתה', tone: 'down', detail: 'מעל 20% מהתיק', pnl: null });
  });

  it('a buy with a stop loss names the stop (D-037)', () => {
    const v = rowView(row({ stopPrice: 95 }), CLOCK);
    expect(v.detail).toBe('תבוצע היום 16:30 · שער פתיחה · סטופ ₪95.00');
  });

  it('a sell a stop loss made says so, with the stop that fired', () => {
    const v = rowView(
      row({
        side: 'sell', status: 'executed', amountIls: null, units: 100, priceType: 'close', executesAt: MON_1730,
        origin: 'stop', stopPrice: 95, fill: { price: 94, fxRate: null, units: 100, ils: 9400, realizedPnlIls: -600 },
      }),
      CLOCK,
    );
    expect(v).toMatchObject({
      side: 'מכירה בסטופ', status: 'בוצעה', detail: 'נמכרה בסטופ לוס ₪95.00 · יום ב׳ 9.11, 17:30 · שער סגירה',
      price: '₪94.00', pnl: '−₪600', pnlTone: 'down',
    });
    expect(v.a11y).toBe('מכירה בסטופ TEVA, 100 יח׳. בוצעה: נמכרה בסטופ לוס ₪95.00 · יום ב׳ 9.11, 17:30 · שער סגירה. הפסד ₪600.');
  });
});

describe('tableColumns', () => {
  it('every column on wide screens, fewer on tablets, two on phones', () => {
    expect(tableColumns(TABLE_FULL).columns.map((c) => c.key)).toEqual(['placed', 'stock', 'side', 'size', 'status', 'price', 'amount', 'pnl']);
    expect(tableColumns(TABLE_FULL - 1).columns.map((c) => c.key)).toEqual(['stock', 'status', 'amount', 'pnl']);
    expect(tableColumns(TABLE_MID - 1).columns.map((c) => c.key)).toEqual(['stock', 'outcome']);
    expect(tableColumns(390).subLine).toBe(true);
    expect(tableColumns(1280).subLine).toBe(false);
  });

  it('leaves the stock room at the smallest width of each set', () => {
    for (const w of [TABLE_MID, TABLE_FULL]) {
      const l = tableColumns(w);
      const fixed = l.columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
      const table = w - 32;   // the page's 16px gutters
      expect(table - fixed - l.gap * (l.columns.length - 1) - l.padX * 2, `width ${w}`).toBeGreaterThanOrEqual(110);
    }
  });
});

describe('paging', () => {
  it('builds the path', () => {
    expect(journalPath('all', 'week')).toBe('/me/journal?filter=all&period=week');
    expect(journalPath('executed', 'all', { before: '42', limit: 40 })).toBe('/me/journal?filter=executed&period=all&before=42&limit=40');
  });

  it('a reload asks for as many rows as are shown, at least a page, at most the API’s cap', () => {
    expect(reloadLimit(0)).toBe(20);
    expect(reloadLimit(60)).toBe(60);
    expect(reloadLimit(250)).toBe(100);
  });

  it('appends a page under the rows, skipping an id already shown, and takes the rest from the newer answer', () => {
    const cur = view({ rows: [row({ id: '9' }), row({ id: '8' })], hasMore: true, counts: { ...COUNTS, all: 4 } });
    const page = view({ rows: [row({ id: '8' }), row({ id: '7' })], hasMore: false, counts: { ...COUNTS, all: 5 } });
    const merged = mergePage(cur, page);
    expect(merged.rows.map((r) => r.id)).toEqual(['9', '8', '7']);
    expect(merged.hasMore).toBe(false);
    expect(merged.counts.all).toBe(5);
  });

  it('asks again in 15 to 30 s while an order is due, at most MAX_DUE_TRIES times', () => {
    expect(dueRetryMs({ due: false }, 0)).toBeNull();
    expect(dueRetryMs({ due: true }, 0, () => 0)).toBe(DUE_RETRY_MS);
    expect(dueRetryMs({ due: true }, 0, () => 1)).toBeLessThan(2 * DUE_RETRY_MS);
    expect(dueRetryMs({ due: true }, MAX_DUE_TRIES)).toBeNull();
  });
});
