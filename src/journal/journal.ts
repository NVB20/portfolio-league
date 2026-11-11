// The trade journal screen's pure logic (/journal, D-035): the sentences, each row's texts, the column set per
// width, and paging. No React, no network. Every number comes from the API (GET /me/journal); nothing here adds
// money up or decides what a win is.
//
// The imports are type-only and end in .js: api/test/app-journal.test.ts loads this file under the API's NodeNext
// type check (src/journal/package.json marks the folder as ES modules). That check sees src/dashboard as CommonJS,
// so the few number formats this file needs are written here instead of imported (as in src/leaderboard/board.ts).

import type {
  LiveClockView,
  TradeJournalFilter,
  TradeJournalPeriod,
  TradeJournalRow,
  TradeJournalView,
  WorldTime,
} from '../../api/src/contract.js';

const MINUS = '−';   // a real minus sign, as in src/dashboard/format.ts
const WEEKDAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];   // Sunday = 0

// ---------- numbers ----------

// 1,284
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

// ₪5,000 for a whole amount, ₪1,234.50 when there are agorot (the dashboard's ilsExact).
export function ils(value: number): string {
  const digits = Math.round(Math.abs(value) * 100) % 100 === 0 ? 0 : 2;
  const sign = value < 0 ? MINUS : '';
  return `${sign}₪${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// A gain or a loss: +₪1,200.50 / −₪300.25 / ₪0.
export function signedIls(value: number): string {
  return value > 0 ? `+${ils(value)}` : ils(value);
}

// A price in its own currency, two decimals: ₪190.03 / $180.00.
export function price(value: number, currency: 'ILS' | 'USD'): string {
  const n = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === 'USD' ? '$' : '₪'}${n}`;
}

// The success rate as the API sends it (one decimal at most): 50% / 66.7%.
export function rate(pct: number): string {
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

// An order's size (D-018): a buy is a ₪ amount, a sell a number of units ("12.5 יח׳", up to 4 decimals).
export function orderSize(r: Pick<TradeJournalRow, 'side' | 'amountIls' | 'units'>): string {
  if (r.side === 'buy') return r.amountIls === null ? '—' : ils(r.amountIls);
  return r.units === null ? '—' : `${r.units.toLocaleString('en-US', { maximumFractionDigits: 4 })} יח׳`;
}

// ---------- time ----------

// "היום 16:30", or "יום ג׳ 10.11, 16:30" on another day. `today` = the world clock's date.
export function when(t: WorldTime, today: string | null): string {
  if (t.date === today) return `היום ${t.time}`;
  const [, m, d] = t.date.split('-');
  return `יום ${WEEKDAY_LETTERS[t.weekday]} ${Number(d)}.${Number(m)}, ${t.time}`;
}

// ---------- the period and the filter ----------

export function periodWord(p: TradeJournalPeriod): string {
  return p === 'week' ? 'השבוע' : 'מתחילת המשחק';
}

const FILTERS: readonly TradeJournalFilter[] = ['all', 'pending', 'executed', 'rejected'];

export const FILTER_LABELS: Record<TradeJournalFilter, string> = {
  all: 'הכל',
  pending: 'ממתינות',
  executed: 'בוצעו',
  rejected: 'נדחו',
};

// "ממתינות 3": the option and how many orders it holds in the period.
export function filterLabel(f: TradeJournalFilter, counts: Record<TradeJournalFilter, number>): string {
  return `${FILTER_LABELS[f]} ${count(counts[f])}`;
}

// The ?filter= in the screen's own URL ("/journal?filter=pending" from the dashboard's pending card). Anything
// unknown is "all".
export function parseFilter(param: string | string[] | undefined): TradeJournalFilter {
  const v = Array.isArray(param) ? param[0] : param;
  return FILTERS.includes(v as TradeJournalFilter) ? (v as TradeJournalFilter) : 'all';
}

// ---------- sentences ----------

function ordersText(n: number): string {
  return n === 1 ? 'פקודה אחת' : `${count(n)} פקודות`;
}

// "רווח ממומש +₪900.25 השבוע." / "הפסד ממומש ₪300 מתחילת המשחק."
export function realizedLine(v: Pick<TradeJournalView, 'period' | 'stats'>): string {
  const pnl = v.stats.realizedPnlIls;
  const text = pnl < 0 ? `הפסד ממומש ${ils(-pnl)}` : `רווח ממומש ${signedIls(pnl)}`;
  return `${text} ${periodWord(v.period)}.`;
}

// Section 1's headline: how many sells made money, then the realized gain. Before the first sell, how many orders
// there are; before the first order, what fills the page.
export function headline(v: Pick<TradeJournalView, 'period' | 'stats' | 'counts'>): { lead: string; accent: string } {
  const s = v.stats;
  const closed = s.wins + s.losses + s.even;
  if (v.counts.all === 0) {
    return { lead: v.period === 'week' ? 'עוד אין פקודות השבוע.' : 'עוד לא שלחת פקודות.', accent: 'פקודה ששולחים מופיעה כאן מיד.' };
  }
  if (closed === 0) return { lead: `${ordersText(v.counts.all)} ${periodWord(v.period)}.`, accent: 'התוצאות יופיעו אחרי המכירה הראשונה.' };
  if (closed === 1) {
    const how = s.wins ? 'ברווח' : s.losses ? 'בהפסד' : 'ב־₪0';
    return { lead: `המכירה שלך נסגרה ${how}.`, accent: realizedLine(v) };
  }
  return { lead: `${count(s.wins)} מתוך ${count(closed)} מכירות ברווח.`, accent: realizedLine(v) };
}

// "7 ברווח · 4 בהפסד", plus "· 1 ב־₪0" when there is one.
export function winLossLine(s: Pick<TradeJournalView['stats'], 'wins' | 'losses' | 'even'>): string {
  const base = `${count(s.wins)} ברווח · ${count(s.losses)} בהפסד`;
  return s.even > 0 ? `${base} · ${count(s.even)} ב־₪0` : base;
}

// Section 2's headline: "6 פקודות השבוע." + how many are still waiting.
export function tableHeadline(v: Pick<TradeJournalView, 'period' | 'counts'>): { lead: string; accent: string | null } {
  const n = v.counts.all;
  if (n === 0) return { lead: v.period === 'week' ? 'אין פקודות השבוע.' : 'אין פקודות עדיין.', accent: null };
  const p = v.counts.pending;
  return {
    lead: `${ordersText(n)} ${periodWord(v.period)}.`,
    accent: p === 0 ? null : p === 1 ? 'אחת מחכה לביצוע.' : `${count(p)} מחכות לביצוע.`,
  };
}

// What the table says when the filter leaves no rows.
export function emptyLine(filter: TradeJournalFilter, period: TradeJournalPeriod): string {
  const p = periodWord(period);
  switch (filter) {
    case 'pending':
      return 'אין פקודות ממתינות. פקודה חדשה מחכה כאן לשער הבא, ואי אפשר לבטל אותה.';
    case 'executed':
      return `עוד אין פקודות שבוצעו ${p}.`;
    case 'rejected':
      return `אין פקודות שנדחו ${p}.`;
    default:
      return `אין פקודות ${p}. פקודה ששולחים מופיעה כאן מיד, ונשארת אחרי שהיא מתבצעת או נדחית.`;
  }
}

// ---------- one row ----------

export type RowView = {
  side: string;                          // קנייה / מכירה
  size: string;                          // ₪10,000 / 5 יח׳
  placed: string;                        // when it was sent
  status: string;                        // ממתינה / בביצוע / בוצעה / נדחתה
  tone: 'warn' | 'ghost' | 'down';       // the status chip
  detail: string;                        // when it runs, when it ran, or why it was rejected
  price: string | null;                  // the fill price, in its own currency
  fx: string | null;                     // US fills: the rate used
  amount: string | null;                 // ₪ paid or received
  pnl: string | null;                    // filled sells: the realized gain; null for anything else
  pnlTone: 'up' | 'down' | 'ghost';
  a11y: string;
};

// `clock` is the loaded world clock: a pending order whose time has passed is being run right now (the runner
// gets to it within about a minute, D-030).
export function rowView(r: TradeJournalRow, clock: Pick<LiveClockView, 'at' | 'date'> | null): RowView {
  const today = clock?.date ?? null;
  const at = r.priceType === 'open' ? 'שער פתיחה' : 'שער סגירה';
  const side = r.side === 'buy' ? 'קנייה' : 'מכירה';
  const size = orderSize(r);
  let status: string;
  let tone: RowView['tone'];
  let detail: string;
  if (r.status === 'pending') {
    const running = clock !== null && Date.parse(r.executesAt.at) <= Date.parse(clock.at);
    status = running ? 'בביצוע' : 'ממתינה';
    tone = 'warn';
    detail = running ? `רצה עכשיו · ${at}` : `תבוצע ${when(r.executesAt, today)} · ${at}`;
  } else if (r.status === 'executed') {
    status = 'בוצעה';
    tone = 'ghost';
    detail = `${when(r.executesAt, today)} · ${at}`;
  } else {
    status = 'נדחתה';
    tone = 'down';
    detail = r.reject?.reason ?? 'הפקודה נדחתה';
  }

  const fill = r.fill;
  const pnlValue = fill?.realizedPnlIls ?? null;
  const pnl = pnlValue === null ? null : signedIls(pnlValue);
  const pnlTone: RowView['pnlTone'] = pnlValue === null || pnlValue === 0 ? 'ghost' : pnlValue > 0 ? 'up' : 'down';
  const result = pnlValue === null ? '' : ` ${pnlValue < 0 ? 'הפסד' : 'רווח'} ${ils(Math.abs(pnlValue))}.`;

  return {
    side,
    size,
    placed: when(r.placedAt, today),
    status,
    tone,
    detail,
    price: fill ? price(fill.price, r.currency) : null,
    fx: fill?.fxRate ? `לפי ₪${fill.fxRate.toFixed(2)} לדולר` : null,
    amount: fill ? ils(fill.ils) : null,
    pnl,
    pnlTone,
    a11y: `${side} ${r.symbol}, ${size}. ${status}: ${detail}.${result}`,
  };
}

// ---------- the table's columns ----------

export type ColumnKey = 'placed' | 'stock' | 'side' | 'size' | 'status' | 'price' | 'amount' | 'pnl' | 'outcome';
export type Column = { key: ColumnKey; label: string; width: number | null };   // null = the stock: takes the rest
export type TableLayout = {
  size: 'phone' | 'mid' | 'full';
  columns: Column[];
  gap: number;
  padX: number;
  padY: number;
  subLine: boolean;   // the side, size and status detail go on lines under the stock
};

export const TABLE_MID = 640;     // the leaderboard's breakpoints (LD-07)
export const TABLE_FULL = 1100;

const LABELS: Record<ColumnKey, string> = {
  placed: 'נשלחה',
  stock: 'מניה',
  side: 'פעולה',
  size: 'גודל',
  status: 'סטטוס',
  price: 'שער ביצוע',
  amount: 'סכום',
  pnl: 'רווח / הפסד',
  outcome: 'תוצאה',
};

const cols = (list: [ColumnKey, number | null][]): Column[] => list.map(([key, width]) => ({ key, label: LABELS[key], width }));

// Wide: every column. Tablet: the stock with its details under it, the status, the ₪ and the result. Phone: the
// stock with its details, and one cell for the outcome (the result of a filled sell, otherwise the status).
export function tableColumns(width: number): TableLayout {
  if (width >= TABLE_FULL) {
    return {
      size: 'full',
      columns: cols([['placed', 124], ['stock', null], ['side', 60], ['size', 100], ['status', 190], ['price', 108], ['amount', 104], ['pnl', 112]]),
      gap: 12,
      padX: 20,
      padY: 12,
      subLine: false,
    };
  }
  if (width >= TABLE_MID) {
    return { size: 'mid', columns: cols([['stock', null], ['status', 180], ['amount', 100], ['pnl', 108]]), gap: 10, padX: 16, padY: 12, subLine: true };
  }
  return { size: 'phone', columns: cols([['stock', null], ['outcome', 108]]), gap: 10, padX: 14, padY: 10, subLine: true };
}

// ---------- paging and reloading ----------

export const PAGE_SIZE = 20;
const MAX_LIMIT = 100;   // the API's ?limit cap

// GET /me/journal for a filter and a period. `before` = the next page (rows sent before that order); `limit` =
// how many rows (a reload asks for as many as are shown).
export function journalPath(filter: TradeJournalFilter, period: TradeJournalPeriod, o: { before?: string; limit?: number } = {}): string {
  let path = `/me/journal?filter=${filter}&period=${period}`;
  if (o.before) path += `&before=${o.before}`;
  if (o.limit) path += `&limit=${o.limit}`;
  return path;
}

// A reload keeps what "טען עוד" added, up to the API's cap.
export function reloadLimit(rowsShown: number): number {
  return Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, rowsShown));
}

// The next page appended: its rows after ours (an id already shown is skipped, so keys stay unique), everything
// else (results, counts, hasMore, the clock) from the newer answer. Rows are paged by order id, which never
// changes, so a page always fits under the rows above it.
export function mergePage(cur: TradeJournalView, page: TradeJournalView): TradeJournalView {
  const shown = new Set(cur.rows.map((r) => r.id));
  return { ...page, rows: [...cur.rows, ...page.rows.filter((r) => !shown.has(r.id))] };
}

// A pending order's time has passed (`due`): the runner runs it within about a minute (D-030), so the screen asks
// again after 15 to 30 s, spread so open screens don't all ask at once. At most MAX_DUE_TRIES in a row. null = don't.
export const DUE_RETRY_MS = 15_000;
export const MAX_DUE_TRIES = 20;

export function dueRetryMs(v: Pick<TradeJournalView, 'due'>, tries: number, rand: () => number = Math.random): number | null {
  if (!v.due || tries >= MAX_DUE_TRIES) return null;
  return DUE_RETRY_MS + Math.floor(Math.min(Math.max(rand(), 0), 0.9999) * DUE_RETRY_MS);
}
