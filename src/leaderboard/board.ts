// The leaderboard screen's pure logic (/leaderboard, docs/design/leaderboard): the column set per width (LD-07),
// the sentences around the player's place, the rank-change arrow (LD-09), past weeks and paging (LD-03).
// No React, no network. The places themselves come from the API (D-032); nothing here ranks or scores anyone.
//
// The imports are type-only and end in .js: api/test/app-leaderboard.test.ts loads this file under the API's
// NodeNext type check (src/leaderboard/package.json marks the folder as ES modules). That check sees
// src/dashboard as CommonJS, so the two number formats this file needs are written here instead of imported.

import type { BoardWeek, LeaderboardMe, LeaderboardRow, LeaderboardView, LiveClockView, PastWeekView } from '../../api/src/contract.js';

const MINUS = '−';   // a real minus sign, as in src/dashboard/format.ts
const DAY_MS = 86_400_000;

// ---------- numbers ----------

// +2.35% / −1.8%: the same as the dashboard's pct().
export function pct(value: number, digits = 2): string {
  const sign = value < 0 ? MINUS : value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

// A score or a gap in points, one decimal (78.4), as everywhere on the board.
export function points(value: number): string {
  return value.toFixed(1);
}

// 1,284
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

// "1,284 שחקנים" / "שחקן אחד"
export function playersText(n: number): string {
  return n === 1 ? 'שחקן אחד' : `${count(n)} שחקנים`;
}

// The gap between two scores in points. Scores are NUMERIC(6,2) sent as JS numbers, so the plain subtraction can
// leave a float tail (0.4999999); rounding to 2 decimals gives the stored difference back.
export function pointsGap(higher: number, lower: number): number {
  return Math.round((higher - lower) * 100) / 100;
}

// A percentile rank (0..100, stored to 2 decimals) as the score breakdown shows it: up to one decimal, 82.5 or 61.
export function rankText(value: number): string {
  return String(Math.round(value * 10) / 10);
}

// "0.85 × 82.5 + 0.15 × 58.5 = 78.9" (rule 6). The ranks show one decimal and the score is stored to two, so the
// shown numbers don't always add up to the shown score: then it says ≈, never a sum that is false.
export function scoreEquation(returnRank: number, stabilityRank: number, score: number): string {
  const r = rankText(returnRank);
  const s = rankText(stabilityRank);
  const sign = points(0.85 * Number(r) + 0.15 * Number(s)) === points(score) ? '=' : '≈';
  return `0.85 × ${r} + 0.15 × ${s} ${sign} ${points(score)}`;
}

// ---------- the week ----------

// ISO week number of a 'YYYY-MM-DD' day: "שבוע 46", the same number the clock shows (ClockView.week).
export function isoWeek(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));   // the Thursday of that week decides the year
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
}

// Which of the week's five days (0 = Monday) the board shows: today's bar in the daily scores.
export function dayIndex(week: BoardWeek): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.min(4, Math.max(0, Math.round((at(week.day) - at(week.start)) / DAY_MS)));
}

// The Monday of a 'YYYY-MM-DD' day.
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

// The game is over and this is its last board: the price history ends (world_clock.ends_at, D-017), so no new week
// will start. True for the final board of the week the history ends in (that week's last event before the end has
// run, D-034), and for any final board once the clock is at the end.
export function gameEnded(week: BoardWeek | null, clock: Pick<LiveClockView, 'at' | 'endsAt'> | null): boolean {
  if (!week?.final || !clock?.endsAt) return false;
  return week.start === mondayOf(clock.endsAt.date) || Date.parse(clock.at) >= Date.parse(clock.endsAt.at);
}

// The eyebrow over the leaderboard on the dashboard and on this page (D-032): the closed week stays on the board
// over the weekend and on Monday until the week's first open. `withWeek` adds "· שבוע 46" while it's live.
// `ended` (gameEnded): the last board of the game, which no new week replaces.
export function boardEyebrow(week: BoardWeek | null, withWeek = false, ended = false): string {
  if (week?.final) return ended ? 'המשחק הסתיים · זו הטבלה הסופית' : 'השבוע נסגר · השבוע החדש מתחיל בפתיחה';
  return week && withWeek ? `טבלת השבוע · שבוע ${isoWeek(week.start)}` : 'טבלת השבוע';
}

// The small print under the leaderboard page. `ended` (gameEnded): no next week will come.
export function boardFooter(ended: boolean): string {
  return ended
    ? 'כל השחקנים חיים באותו שעון. נתוני המחירים נגמרו, וזו הטבלה הסופית.'
    : 'כל השחקנים חיים באותו שעון. כל שבוע מתחיל טבלה חדשה; הטבלה של השבוע שנסגר נשארת כאן עד הפתיחה הראשונה של השבוע הבא.';
}

// The name and rank under the avatar in the top bar, as on the dashboard: "מקום #12 · שבוע 46".
export function rankLine(rank: number | null, week: number | null): string | null {
  if (rank === null) return null;
  return week === null ? `מקום #${rank}` : `מקום #${rank} · שבוע ${week}`;
}

// ---------- the player's place ----------

// The line under the place: how far the place above is. null when first (nobody above).
// Scores show one decimal but the order uses all of them plus the tie-breaks (D-032), so a gap can be below what
// one decimal shows, or zero.
export function pointsToNext(me: Pick<LeaderboardMe, 'score' | 'ahead'>): string | null {
  if (!me.ahead) return null;
  const gap = pointsGap(me.ahead.score, me.score);
  const place = `למקום ${me.ahead.rank}`;
  if (gap <= 0) return `ציון זהה ${place}. הוא לפניך בשובר השוויון.`;
  if (gap < 0.1) return `פחות מ־0.1 נקודות ${place}.`;
  return `עוד ${points(gap)} נקודות ${place}.`;
}

// The accent line next to the place: what the place means right now.
export function placeLine(me: Pick<LeaderboardMe, 'rank' | 'score' | 'ahead'>, final: boolean): string {
  if (final) return me.rank === 1 ? 'סיימת את השבוע בראש הטבלה.' : 'זה המקום הסופי שלך השבוע.';
  return pointsToNext(me) ?? 'אתה בראש הטבלה.';
}

// Which top share a place is in: 12 of 1,284 is the top 1%. Never 0%. null when nobody is on the board.
export function topPercent(rank: number, players: number): number | null {
  if (players <= 0) return null;
  return Math.min(100, Math.max(1, Math.ceil((rank / players) * 100)));
}

// "אתה ב־1% העליון." in the top half; below it, how many players are behind, which reads kinder than "top 80%".
export function topLine(rank: number, players: number): string {
  if (rank === 1) return 'אתה במקום הראשון.';
  const share = topPercent(rank, players);
  if (share !== null && share <= 50) return `אתה ב־${share}% העליון.`;
  const behind = players - rank;
  if (behind <= 0) return 'אתה בסוף הטבלה.';
  return behind === 1 ? 'שחקן אחד מאחוריך.' : `${count(behind)} שחקנים מאחוריך.`;
}

// Section 1's headline. `place` set = render "מקום <12> מתוך 1,284." with the rank highlighted; `lead` is the same
// sentence as plain text. Not ranked in a live week = no stock held and no trade this week (D-034); the card under
// the headline (unrankedLine) says how to get on.
export type Headline = { place: { rank: number; players: number } | null; lead: string; accent: string };

export function headline(v: Pick<LeaderboardView, 'week' | 'players' | 'me'>): Headline {
  if (!v.week) return { place: null, lead: 'הטבלה עוד לא נפתחה.', accent: 'היא תתמלא אחרי שהציונים יחושבו.' };
  if (!v.me) {
    return v.week.final
      ? { place: null, lead: 'לא דורגת בשבוע שנסגר.', accent: `${playersText(v.players)} בטבלה הסופית.` }
      : { place: null, lead: 'עוד לא בדירוג השבוע.', accent: `${playersText(v.players)} בטבלה כרגע.` };
  }
  return {
    place: { rank: v.me.rank, players: v.players },
    lead: `מקום ${v.me.rank} מתוך ${count(v.players)}.`,
    accent: placeLine(v.me, v.week.final),
  };
}

// Section 2's headline: "1,284 שחקנים." + where you are among them.
export function tableHeadline(v: Pick<LeaderboardView, 'week' | 'players' | 'me'>): { lead: string; accent: string | null } {
  if (!v.week || v.players === 0) return { lead: 'עוד אין שחקנים בטבלה.', accent: null };
  const lead = `${playersText(v.players)}.`;
  if (v.me) return { lead, accent: topLine(v.me.rank, v.players) };
  return { lead, accent: v.week.final ? 'לא דורגת בשבוע הזה.' : 'עוד לא בדירוג השבוע.' };
}

// How a player gets on the board (D-034): everyone who holds a stock, or traded this week, is ranked at every open
// and close. So a player who isn't joins at the open or close where a buy of theirs fills. A closed week is over:
// it only says you weren't ranked, and promises nothing.
const ON_BUY = 'כשקנייה שלך תתבצע, בפתיחה או בסגירה';

// The text inside "your place" when you're not on the board.
export function unrankedLine(week: BoardWeek | null): string {
  if (!week) return `תיכנס לטבלה ${ON_BUY}.`;
  if (week.final) return 'לא דורגת בשבוע שנסגר.';
  return `עוד לא בדירוג השבוע. כל מי שמחזיק מניה או שסחר השבוע נמצא בטבלה. תיכנס אליה ${ON_BUY}.`;
}

// The dashboard's score card when you're not on the board shown. `final` = that board is a closed week.
export function noScoreLine(final: boolean): string {
  return final ? 'לא דורגת בשבוע שנסגר.' : `עוד אין לך ציון השבוע. הוא יופיע כאן ${ON_BUY}.`;
}

// ---------- rows ----------

// ▲ 5 / ▼ 2 / – : places gained since the previous scored day of this week (LD-09). null = its first scored day.
export type Delta = { text: string; tone: 'up' | 'down' | 'flat'; label: string };

export function rankDelta(change: number | null): Delta {
  if (change === null) return { text: '–', tone: 'flat', label: 'אין יום קודם השבוע' };
  if (change === 0) return { text: '–', tone: 'flat', label: 'בלי שינוי במקום' };
  const n = Math.abs(change);
  if (change > 0) return { text: `▲ ${n}`, tone: 'up', label: n === 1 ? 'עלה מקום אחד' : `עלה ${n} מקומות` };
  return { text: `▼ ${n}`, tone: 'down', label: n === 1 ? 'ירד מקום אחד' : `ירד ${n} מקומות` };
}

// The letter on a player's avatar (LD-08). Array.from keeps an emoji or a surrogate pair whole.
export function initial(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toLocaleUpperCase('en-US') : '?';
}

// Which of the five fills (theme.ts fixed.avatarFills). The API sends 0..4; anything else falls back safely.
export function avatarSlot(avatar: number): number {
  return Number.isInteger(avatar) ? ((avatar % 5) + 5) % 5 : 0;
}

// The ▲ / ▼ chip next to a place: "▲ 5 מהיום הקודם". The previous scored day of the week, not "yesterday" (LD-09).
export function rankChangeText(change: number): string {
  return `${change > 0 ? '▲' : '▼'} ${Math.abs(change)} מהיום הקודם`;
}

// What a screen reader says for one row.
export function rowLabel(r: LeaderboardRow): string {
  const who = r.isMe ? `${r.name} (אתה)` : r.name;
  return `מקום ${r.rank}, ${who}. ציון ${points(r.score)}. תשואה ${pct(r.returnPct)}. ירידה מקסימלית ${pct(-r.maxDrawdownPct, 1)}. ${rankDelta(r.rankChange).label}.`;
}

// The five daily-score bars (Mon..Fri): height in % (null = no score that day, no bar); `today` = the day shown.
export function dailyBars(days: (number | null)[], today: number): { height: number | null; today: boolean }[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const s = days[i];
    return { height: s === null || s === undefined ? null : Math.min(100, Math.max(4, s)), today: i === today };
  });
}

// ---------- the table's columns (LD-07) ----------

export type ColumnKey = 'rank' | 'player' | 'score' | 'return' | 'drawdown' | 'returnRank' | 'stabilityRank' | 'change' | 'days';
export type Column = { key: ColumnKey; label: string; width: number | null };   // null = the name: takes the rest
export type TableLayout = {
  size: 'phone' | 'mid' | 'full';
  columns: Column[];
  gap: number;
  padX: number;
  padY: number;
  subLine: boolean;   // phones: return and drawdown on a second line under the name
};

export const TABLE_MID = 640;
export const TABLE_FULL = 1100;

const LABELS: Record<ColumnKey, string> = {
  rank: '#',
  player: 'שחקן',
  score: 'ציון',
  return: 'תשואה שבועית',
  drawdown: 'ירידה מקסימלית',
  returnRank: 'דירוג תשואה',
  stabilityRank: 'דירוג יציבות',
  // Not "since yesterday": the change is against the previous SCORED day of the week (LD-09), which on the weekend,
  // on Monday before the open and after a day with no market open is not yesterday.
  change: 'שינוי במקום',
  days: 'ציון יומי',
};

const cols = (list: [ColumnKey, number | null][]): Column[] => list.map(([key, width]) => ({ key, label: LABELS[key], width }));

// The widths are the mock-up's, narrowed where they would leave the name no room at the smallest width of a set
// (640px wide = a 608px table). The window width picks the set, like the mock-up's media queries.
export function tableColumns(width: number): TableLayout {
  if (width >= TABLE_FULL) {
    return {
      size: 'full',
      columns: cols([['rank', 44], ['player', null], ['score', 100], ['return', 110], ['drawdown', 104], ['returnRank', 84], ['stabilityRank', 84], ['change', 80], ['days', 88]]),
      gap: 12,
      padX: 20,
      padY: 12,
      subLine: false,
    };
  }
  if (width >= TABLE_MID) {
    return {
      size: 'mid',
      columns: cols([['rank', 40], ['player', null], ['score', 84], ['return', 100], ['drawdown', 92], ['change', 72]]),
      gap: 10,
      padX: 16,
      padY: 12,
      subLine: false,
    };
  }
  return { size: 'phone', columns: cols([['rank', 36], ['player', null], ['score', 76]]), gap: 10, padX: 14, padY: 10, subLine: true };
}

// ---------- the podium ----------

// Display order in a right-to-left row: #2 on the right, #1 in the middle, #3 on the left (the mock-up).
export function podiumOrder(podium: LeaderboardRow[]): LeaderboardRow[] {
  const at = (rank: number) => podium.find((r) => r.rank === rank);
  return [at(2), at(1), at(3)].filter((r): r is LeaderboardRow => r !== undefined);
}

export const PODIUM_HEIGHTS: Record<number, number> = { 1: 96, 2: 64, 3: 44 };

// "הפער בינך לפודיום: 10.6 נקודות", or that you're on it. null when you're not on the board.
export function podiumLine(me: Pick<LeaderboardMe, 'rank' | 'score'> | null, podium: LeaderboardRow[]): string | null {
  if (!me) return null;
  if (me.rank <= 3) return 'אתה על הפודיום.';
  const third = podium.find((r) => r.rank === 3);
  if (!third) return null;
  const gap = pointsGap(third.score, me.score);
  if (gap <= 0) return 'ציון זהה למקום 3.';
  if (gap < 0.1) return 'פחות מ־0.1 נקודות מהפודיום.';
  return `הפער בינך לפודיום: ${points(gap)} נקודות`;
}

// ---------- past weeks (LD-10) ----------

export type WeekColumn = {
  key: string;
  label: string;     // "שבוע 45", "46 · עכשיו"
  rank: number;
  players: number;
  score: number;
  height: number;    // the bar, in %: a better finish is taller, measured against that week's field
  current: boolean;  // the board's own week
  a11y: string;
};

// The bar for a finish: 1st of N = 100%, last = a sliver. Against the week's own field, so weeks of different
// sizes compare fairly.
export function finishHeight(rank: number, players: number): number {
  if (players <= 0) return 8;
  return Math.max(8, Math.min(100, Math.round((100 * (players - rank + 1)) / players)));
}

// Oldest first (in a right-to-left row that reads right to left), then the board's week when you're on it.
export function weekColumns(past: PastWeekView[], me: Pick<LeaderboardMe, 'rank' | 'players' | 'score'> | null, week: BoardWeek | null): WeekColumn[] {
  const out: WeekColumn[] = [...past].reverse().map((w) => {
    const n = isoWeek(w.weekStart);
    return {
      key: w.weekStart,
      label: `שבוע ${n}`,
      rank: w.rank,
      players: w.players,
      score: w.score,
      height: finishHeight(w.rank, w.players),
      current: false,
      a11y: `שבוע ${n}: מקום ${w.rank} מתוך ${count(w.players)}, ציון ${points(w.score)}`,
    };
  });
  if (me && week) {
    const n = isoWeek(week.start);
    out.push({
      key: week.start,
      label: `${n} · ${week.final ? 'סופי' : 'עכשיו'}`,
      rank: me.rank,
      players: me.players,
      score: me.score,
      height: finishHeight(me.rank, me.players),
      current: true,
      a11y: `שבוע ${n}${week.final ? ', סופי' : ', עכשיו'}: מקום ${me.rank} מתוך ${count(me.players)}, ציון ${points(me.score)}`,
    });
  }
  return out;
}

// "השיא שלך: מקום 12, שבוע 46." The best finish among the columns; null when there are none.
export function bestLine(columns: WeekColumn[]): string | null {
  const best = columns.reduce<WeekColumn | null>((b, c) => (!b || c.rank < b.rank ? c : b), null);
  if (!best) return null;
  const when = best.current ? 'השבוע' : best.label;
  return `השיא שלך: מקום ${best.rank}, ${when}.`;
}

// ---------- paging (LD-03) ----------

export type TableView = 'top' | 'around';
export const PAGE_SIZE = 20;

// GET /me/leaderboard: ?view=top&from=N (20 rows from place N) or ?view=around (my place ± 5).
export function boardPath(view: TableView, from = 1): string {
  return view === 'around' ? '/me/leaderboard?view=around' : `/me/leaderboard?view=top&from=${from}`;
}

// The place "טען עוד 20" starts from: the one after the last row.
export function nextFrom(v: Pick<LeaderboardView, 'rows'>): number {
  const last = v.rows[v.rows.length - 1];
  return last ? last.rank + 1 : 1;
}

// Is `page`, a later answer, from the same ranking as what's loaded, so its rows can go under ours? The same day
// is not enough: the scoring rewrites a day's places at every open and close (D-034), and a page from the new
// ranking under rows from the old one could show a player twice, or not at all (two neighbours who swap places
// change neither the count, the podium nor my row). `scoredAt` is exact: the latest finished open or close, which
// commits with the rewrite. The player count also catches a deleted user's rows.
type Ranking = Pick<LeaderboardView, 'week' | 'players' | 'scoredAt'>;

export function sameBoard(a: Ranking, b: Ranking): boolean {
  return a.week?.start === b.week?.start && a.week?.day === b.week?.day && a.scoredAt === b.scoredAt && a.players === b.players;
}

// The board is behind the clock (`behind`: an open or close has passed and isn't scored yet). The screen's reload
// at an open or close usually comes before the runner has scored it (the ticker runs it up to a minute later), so
// the screen asks again after this many ms: 15 to 30 s, spread so open screens don't all ask at the same moment.
// At most MAX_BEHIND_TRIES in a row (5 to 10 minutes: an event at a million players takes about a minute, D-034).
// null = don't ask again.
export const BEHIND_RETRY_MS = 15_000;
export const MAX_BEHIND_TRIES = 20;

export function behindRetryMs(v: Pick<LeaderboardView, 'behind'>, tries: number, rand: () => number = Math.random): number | null {
  if (!v.behind || tries >= MAX_BEHIND_TRIES) return null;
  return BEHIND_RETRY_MS + Math.floor(Math.min(Math.max(rand(), 0), 0.9999) * BEHIND_RETRY_MS);
}

// A page appended to what's loaded: its rows after ours (a place already shown is skipped, so keys stay unique),
// everything else (players, hasMore, me, podium) from the newer answer. The view and the first place stay ours.
export function mergePage(cur: LeaderboardView, page: LeaderboardView): LeaderboardView {
  const shown = new Set(cur.rows.map((r) => r.rank));
  return { ...page, view: cur.view, from: cur.from, rows: [...cur.rows, ...page.rows.filter((r) => !shown.has(r.rank))] };
}

// "1–20" for the footer's "מציג 1–20 מתוך 1,284". null when there are no rows. Rendered as its own text run,
// so the range doesn't flip inside the Hebrew sentence.
export function shownRange(rows: Pick<LeaderboardRow, 'rank'>[]): string | null {
  if (rows.length === 0) return null;
  const first = rows[0].rank;
  const last = rows[rows.length - 1].rank;
  return first === last ? String(first) : `${first}–${last}`;
}
