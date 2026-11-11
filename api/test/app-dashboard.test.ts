// The dashboard's pure helpers (src/dashboard/): the rejection toasts (D-023, D-031), the two market chips and
// the "only one market today" line (D-022), and the cash figures. No database, no React.
//
// Why the app files are loaded at run time instead of imported: the root package.json has no "type": "module",
// so to this package's TypeScript (NodeNext + verbatimModuleSyntax) every file under src/ is CommonJS, where an
// `export` is an error. A static import would pull them into `npm run typecheck` and fail it. vitest loads them
// as they are; their shapes are written out below from the shared contract (the app's own `npx tsc` checks them).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ClockView, Dashboard, HoldingView, LiveClockView, MarketSession, PortfolioView, RejectionView, StandingView, WorldTime,
} from '../src/contract.js';

const app = <T>(path: string): Promise<T> => import(new URL(`../../src/${path}.ts`, import.meta.url).href) as Promise<T>;

type Notice = { id: string; title: string; reason: string; when: string };
type MarketChip = { key: 'tase' | 'us'; label: string; open: boolean; state: string; a11y: string };
type LiveTime = { weekday: number; minutes: number; dayOffset: number; ended: boolean };   // src/dashboard/liveClock.ts

const { rejectionNotices, rejectionsHeading, idsToMark, REJECTION_FALLBACK } = await app<{
  rejectionNotices(rejections: RejectionView[], holdings: Pick<HoldingView, 'symbol' | 'nameHe'>[]): Notice[];
  rejectionsHeading(count: number): string;
  idsToMark(shown: string[], sent: ReadonlySet<string>): string[];
  REJECTION_FALLBACK: Record<NonNullable<RejectionView['code']>, string>;
}>('dashboard/rejections');

const { marketChips, oneMarketToday, marketsChanged } = await app<{
  marketChips(markets: ClockView['markets'], t?: LiveTime): MarketChip[];
  marketsChanged(clock: LiveClockView, elapsedMs: number): boolean;
  oneMarketToday(markets: ClockView['markets']): string | null;
}>('dashboard/markets');

const { cashFigures, standingSummary } = await app<{
  cashFigures(p: Pick<PortfolioView, 'availableCash' | 'reservedCash'>): { label: string; value: string }[];
  standingSummary(d: Dashboard): string;
}>('dashboard/copy');

// ---------- rejection toasts ----------

// Tuesday 10.11.2026 at the TASE close.
const TUE_CLOSE: WorldTime = { at: '2026-11-10T15:30:00.000Z', date: '2026-11-10', weekday: 2, time: '17:30' };

const rejection = (r: Partial<RejectionView>): RejectionView => ({
  id: '41',
  symbol: 'TEVA',
  side: 'buy',
  amountIls: 5000,
  units: null,
  code: 'INSUFFICIENT_CASH',
  reason: 'אין מספיק מזומן פנוי',
  at: TUE_CLOSE,
  ...r,
});

const HOLDINGS = [{ symbol: 'TEVA', nameHe: 'טבע' }];

describe('rejection toasts (D-023)', () => {
  it('a buy: side, the Hebrew name, the ₪ amount, the server reason and when it was rejected', () => {
    expect(rejectionNotices([rejection({})], HOLDINGS)).toEqual([
      { id: '41', title: 'קנייה טבע · ₪5,000', reason: 'אין מספיק מזומן פנוי', when: 'יום ג׳ 17:30' },
    ]);
  });

  it('a sell shows units; a security the player does not hold shows its symbol', () => {
    const [n] = rejectionNotices(
      [rejection({ symbol: 'AAPL', side: 'sell', amountIls: null, units: 12.5, code: 'INSUFFICIENT_UNITS', reason: 'אין מספיק יחידות למכירה' })],
      HOLDINGS,
    );
    expect(n.title).toBe('מכירה AAPL · 12.5 יח׳');
    expect(n.reason).toBe('אין מספיק יחידות למכירה');
  });

  it('agorot are shown, never rounded away; units like the pending orders card (up to 4 decimals)', () => {
    expect(rejectionNotices([rejection({ amountIls: 1234.5 })], HOLDINGS)[0].title).toBe('קנייה טבע · ₪1,234.50');
    expect(rejectionNotices([rejection({ side: 'sell', amountIls: null, units: 0.12345678 })], HOLDINGS)[0].title).toBe('מכירה טבע · 0.1235 יח׳');
  });

  it("keeps the server's own Hebrew reason word for word (the 20% message carries the share)", () => {
    const reason = 'ההחזקה הייתה מגיעה ל־21.3% מהתיק (מותר עד 20%)';
    expect(rejectionNotices([rejection({ code: 'OVER_LIMIT', reason })], HOLDINGS)[0].reason).toBe(reason);
  });

  it('falls back to a Hebrew text per code when the reason is empty', () => {
    for (const code of ['NO_PRICE', 'INSUFFICIENT_CASH', 'OVER_LIMIT', 'INSUFFICIENT_UNITS'] as const) {
      const [n] = rejectionNotices([rejection({ code, reason: '  ' })], HOLDINGS);
      expect(n.reason).toBe(REJECTION_FALLBACK[code]);
      expect(n.reason).not.toBe('');
    }
    expect(rejectionNotices([rejection({ code: null, reason: '' })], HOLDINGS)[0].reason).toBe('הפקודה לא עמדה בכללים בזמן הביצוע');
  });

  it('several at once: one notice each, in the order the API sent them (newest first)', () => {
    const list = [
      rejection({ id: '9' }),
      rejection({ id: '7', symbol: 'MSFT', amountIls: 250 }),
      rejection({ id: '12', side: 'sell', amountIls: null, units: 3 }),
    ];
    const notices = rejectionNotices(list, HOLDINGS);
    expect(notices.map((n) => n.id)).toEqual(['9', '7', '12']);
    expect(notices.map((n) => n.title)).toEqual(['קנייה טבע · ₪5,000', 'קנייה MSFT · ₪250', 'מכירה טבע · 3 יח׳']);
    expect(rejectionNotices([], HOLDINGS)).toEqual([]);
  });

  it('the heading counts them', () => {
    expect(rejectionsHeading(1)).toBe('פקודה נדחתה');
    expect(rejectionsHeading(3)).toBe('3 פקודות נדחו');
  });
});

describe('idsToMark: what POST /me/rejections/seen gets (D-031)', () => {
  it('exactly the ids on screen', () => {
    expect(idsToMark(['9', '7'], new Set())).toEqual(['9', '7']);
  });

  it('never an id already sent, and each id once', () => {
    expect(idsToMark(['9', '7', '12'], new Set(['7']))).toEqual(['9', '12']);
    expect(idsToMark(['9', '9'], new Set())).toEqual(['9']);
    expect(idsToMark(['9'], new Set(['9']))).toEqual([]);
    expect(idsToMark([], new Set())).toEqual([]);
  });

  it('at most 5 per call (the API refuses more); the rest show again next time', () => {
    expect(idsToMark(['1', '2', '3', '4', '5', '6'], new Set())).toEqual(['1', '2', '3', '4', '5']);
  });
});

// ---------- market status (D-022) ----------

const SESSION_TASE = { openMin: 600, closeMin: 1050 };   // 10:00-17:30
const SESSION_US = { openMin: 990, closeMin: 1380 };     // 16:30-23:00
const NEXT: WorldTime = { at: '2026-04-06T07:00:00.000Z', date: '2026-04-06', weekday: 1, time: '10:00' };

const trading = (session: { openMin: number; closeMin: number }, state: MarketSession['state']): MarketSession => ({
  isOpen: state === 'open',
  session,
  state,
  reason: null,
  nextOpen: state === 'open' ? null : NEXT,
});
const closedAllDay = (state: 'holiday' | 'weekend', reason: string | null): MarketSession => ({
  isOpen: false,
  session: null,
  state,
  reason,
  nextOpen: NEXT,
});

describe('market chips: ת״א and ניו יורק, each open or closed', () => {
  it('reads isOpen of each market, TASE first', () => {
    expect(marketChips({ tase: trading(SESSION_TASE, 'open'), us: trading(SESSION_US, 'pre_open') })).toEqual([
      { key: 'tase', label: 'ת״א', open: true, state: 'פתוחה', a11y: 'תל אביב פתוחה' },
      { key: 'us', label: 'ניו יורק', open: false, state: 'סגורה', a11y: 'ניו יורק סגורה' },
    ]);
    expect(marketChips({ tase: trading(SESSION_TASE, 'after_close'), us: trading(SESSION_US, 'open') }).map((c) => c.open)).toEqual([false, true]);
  });

  it('both closed on the weekend', () => {
    const chips = marketChips({ tase: closedAllDay('weekend', null), us: closedAllDay('weekend', null) });
    expect(chips.map((c) => c.open)).toEqual([false, false]);
  });

  it('the state is in words too, not only in the colour of the dot', () => {
    const chips = marketChips({ tase: trading(SESSION_TASE, 'open'), us: trading(SESSION_US, 'pre_open') });
    expect(chips.map((c) => `${c.label} ${c.state}`)).toEqual(['ת״א פתוחה', 'ניו יורק סגורה']);
  });

  it('with the live time, a chip follows the clock between loads (like the world time panel)', () => {
    const markets = { tase: trading(SESSION_TASE, 'open'), us: trading(SESSION_US, 'open') };   // loaded at 17:25
    const at = (minutes: number, dayOffset = 0): LiveTime => ({ weekday: 2, minutes, dayOffset, ended: false });
    expect(marketChips(markets, at(17 * 60 + 29)).map((c) => c.open)).toEqual([true, true]);
    expect(marketChips(markets, at(17 * 60 + 31)).map((c) => c.open)).toEqual([false, true]);   // TASE closed at 17:30
    expect(marketChips(markets, at(23 * 60)).map((c) => c.open)).toEqual([false, false]);       // New York closed at 23:00
    expect(marketChips(markets, at(10 * 60 + 30, 1)).map((c) => c.open)).toEqual([false, false]);   // the next day: unknown until a load
  });
});

// ---------- the loaded data vs. the live clock (the trading screen reloads when they part) ----------

// Tuesday 10.11.2026, 17:25, the clock running: both markets open, TASE closes at 17:30.
const LIVE: LiveClockView = {
  at: '2026-11-10T15:25:00.000Z',
  date: '2026-11-10',
  weekday: 2,
  time: '17:25',
  week: 46,
  weekStartAt: '2026-11-08T22:00:00.000Z',
  markets: { tase: trading(SESSION_TASE, 'open'), us: trading(SESSION_US, 'open') },
  running: true,
  endsAt: null,
};
const MIN = 60_000;

describe('marketsChanged: the screen\'s data no longer describes the live moment', () => {
  it('false while nothing opens or closes', () => {
    expect(marketsChanged(LIVE, 0)).toBe(false);
    expect(marketsChanged(LIVE, 4 * MIN)).toBe(false);
  });

  it('true once a market opens or closes (an order sent now would run at another time)', () => {
    expect(marketsChanged(LIVE, 6 * MIN)).toBe(true);   // 17:31: TASE closed, its orders now run at the next open
    const morning: LiveClockView = { ...LIVE, time: '09:55', markets: { tase: trading(SESSION_TASE, 'pre_open'), us: trading(SESSION_US, 'pre_open') } };
    expect(marketsChanged(morning, 4 * MIN)).toBe(false);
    expect(marketsChanged(morning, 6 * MIN)).toBe(true);   // 10:01: TASE opened, orders now run at the close
  });

  it('sees a close within a tick, not up to a minute late (clock.time drops the seconds of clock.at)', () => {
    const justBefore: LiveClockView = { ...LIVE, at: '2026-11-10T15:29:50.000Z', time: '17:29' };   // 17:29:50
    expect(marketsChanged(justBefore, 5_000)).toBe(false);   // 17:29:55
    expect(marketsChanged(justBefore, 15_000)).toBe(true);   // 17:30:05: TASE closed
  });

  it('true past midnight (a new world day)', () => {
    const late: LiveClockView = { ...LIVE, time: '23:40', markets: { tase: trading(SESSION_TASE, 'after_close'), us: trading(SESSION_US, 'after_close') } };
    expect(marketsChanged(late, 19 * MIN)).toBe(false);
    expect(marketsChanged(late, 21 * MIN)).toBe(true);
  });

  it('true when the clock reaches its end; false if it was already there when loaded', () => {
    const endsAt: WorldTime = { at: '2026-11-10T15:27:00.000Z', date: '2026-11-10', weekday: 2, time: '17:27' };
    expect(marketsChanged({ ...LIVE, endsAt }, MIN)).toBe(false);
    expect(marketsChanged({ ...LIVE, endsAt }, 3 * MIN)).toBe(true);
    const atEnd: LiveClockView = { ...LIVE, endsAt: { ...endsAt, at: LIVE.at, time: '17:25' } };
    expect(marketsChanged(atEnd, 30 * MIN)).toBe(false);
  });

  it('never while the admin has the clock stopped', () => {
    expect(marketsChanged({ ...LIVE, running: false }, 120 * MIN)).toBe(false);
  });
});

describe('oneMarketToday: the line when only one market trades today', () => {
  it('both markets trade today: no line (whether open right now or not)', () => {
    expect(oneMarketToday({ tase: trading(SESSION_TASE, 'open'), us: trading(SESSION_US, 'pre_open') })).toBeNull();
    expect(oneMarketToday({ tase: trading(SESSION_TASE, 'after_close'), us: trading(SESSION_US, 'open') })).toBeNull();
  });

  it('both closed all day: no line', () => {
    expect(oneMarketToday({ tase: closedAllDay('weekend', null), us: closedAllDay('weekend', null) })).toBeNull();
    expect(oneMarketToday({ tase: closedAllDay('holiday', 'פסח'), us: closedAllDay('holiday', 'יום שישי הטוב') })).toBeNull();
  });

  it('US only: TASE closed for a holiday, with its reason', () => {
    expect(oneMarketToday({ tase: closedAllDay('holiday', 'פסח'), us: trading(SESSION_US, 'pre_open') })).toBe(
      'היום רק ניו יורק פתוחה · ת״א סגורה: פסח',
    );
  });

  it('TASE only: New York closed for a holiday', () => {
    expect(oneMarketToday({ tase: trading(SESSION_TASE, 'open'), us: closedAllDay('holiday', 'חג ההודיה') })).toBe(
      'היום רק ת״א פתוחה · ניו יורק סגורה: חג ההודיה',
    );
  });

  it('Friday before 2026: TASE closed, the reason comes from the data', () => {
    const reason = 'הבורסה בת״א סגורה בימי שישי עד ינואר 2026';
    expect(oneMarketToday({ tase: closedAllDay('holiday', reason), us: trading(SESSION_US, 'open') })).toBe(
      `היום רק ניו יורק פתוחה · ת״א סגורה: ${reason}`,
    );
  });

  it('weekend without a reason says "סוף שבוע"', () => {
    expect(oneMarketToday({ tase: closedAllDay('weekend', null), us: trading(SESSION_US, 'pre_open') })).toBe(
      'היום רק ניו יורק פתוחה · ת״א סגורה: סוף שבוע',
    );
  });

  it('a holiday without a reason just says closed', () => {
    expect(oneMarketToday({ tase: trading(SESSION_TASE, 'pre_open'), us: closedAllDay('holiday', null) })).toBe(
      'היום רק ת״א פתוחה · ניו יורק סגורה',
    );
  });

  it("still true after the one market's close: it is about today", () => {
    expect(oneMarketToday({ tase: closedAllDay('holiday', 'פסח'), us: trading(SESSION_US, 'after_close') })).toBe(
      'היום רק ניו יורק פתוחה · ת״א סגורה: פסח',
    );
  });
});

// ---------- cash on the portfolio card ----------

describe('cashFigures: available cash, and the reserved part when there is one', () => {
  it('no pending buys: only the available cash', () => {
    expect(cashFigures({ availableCash: 1_000_000, reservedCash: 0 })).toEqual([{ label: 'מזומן פנוי', value: '₪1,000,000' }]);
  });

  it('pending buys: the reserved cash too', () => {
    expect(cashFigures({ availableCash: 300_000, reservedCash: 12_900 })).toEqual([
      { label: 'מזומן פנוי', value: '₪300,000' },
      { label: 'שמור לפקודות ממתינות', value: '₪12,900' },
    ]);
  });

  it('agorot are shown when there are any', () => {
    expect(cashFigures({ availableCash: 299_899.5, reservedCash: 100.25 }).map((f) => f.value)).toEqual(['₪299,899.50', '₪100.25']);
  });
});

// ---------- the standing sentence (D-034) ----------

describe('standingSummary: the drawdown advice only when it is true, with the number from the board', () => {
  const standing = (o: Partial<StandingView> = {}): StandingView => ({
    rank: 5, players: 40, score: 70, returnRank: 80, stabilityRank: 30, rankChange: null, days: [], maxDrawdownPct: 2.5, ...o,
  });
  // Only what the sentence reads; the portfolio's drawdown is set to a number that must never show.
  const dash = (s: StandingView | null) => ({ standing: s, portfolio: { maxDrawdownPct: 0 } }) as unknown as Dashboard;

  it('the leader gets no advice, even with the weaker stability rank', () => {
    const leader = standingSummary(dash(standing({ rank: 1, returnRank: 100, stabilityRank: 75, maxDrawdownPct: 1.2 })));
    expect(leader).not.toContain('יותר מרוב');
    expect(standingSummary(dash(standing({ rank: 1, returnRank: 100, stabilityRank: 0 })))).not.toContain('יותר מרוב');
  });

  it('a stability rank of 50 or more is not "more than most players": the plain score line', () => {
    expect(standingSummary(dash(standing({ stabilityRank: 60 })))).toBe('ציון 70.0 מתוך 100, מקום 5 מתוך 40 שחקנים.');
    expect(standingSummary(dash(standing({ stabilityRank: 50 })))).toBe('ציון 70.0 מתוך 100, מקום 5 מתוך 40 שחקנים.');
  });

  it('below 50 and below the return rank: the advice, with the drawdown of the board row, never of the portfolio', () => {
    const advice = standingSummary(dash(standing({ stabilityRank: 30, maxDrawdownPct: 2.5 })));
    expect(advice).toContain('יותר מרוב');
    expect(advice).toContain('2.5%');
    expect(advice).not.toContain('0.0%');
    // Stability below 50 but not the weaker rank: the return is what holds the place back, so no drawdown advice.
    expect(standingSummary(dash(standing({ returnRank: 20, stabilityRank: 30 })))).not.toContain('יותר מרוב');
  });
});

// ---------- no dead buttons for screens that exist ----------

describe('buttons for built screens are connected', () => {
  const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

  it('the full-table button of the admin page and the advance button of the clock card no longer say "not built yet"', () => {
    const admin = source('screens/AdminDashboardScreen.tsx');
    const clockCard = source('components/dashboard/WorldClockCard.tsx');
    expect(admin).not.toContain('יחובר כשמסך הטבלה ייבנה');
    expect(admin).toContain("router.navigate('/leaderboard')");
    expect(clockCard).not.toContain('יחובר כשקידום השעון ייבנה');
    // It opens the admin page at its world clock section (?to=clock), not at the top.
    expect(clockCard).toContain("router.navigate({ pathname: '/admin-dashboard', params: { to: 'clock' } })");
  });
});
