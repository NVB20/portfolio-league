// The leaderboard screen's pure helpers (src/leaderboard/board.ts): columns per width (LD-07), the sentences around
// the player's place, the rank-change arrow (LD-09), past weeks (LD-10) and paging (LD-03). No database, no React.
// The app file is an ES module for this NodeNext check because of src/leaderboard/package.json ("type": "module").

import { describe, expect, it } from 'vitest';
import type { BoardWeek, LeaderboardMe, LeaderboardRow, LeaderboardView, LiveClockView, PastWeekView } from '../src/contract.js';
import {
  avatarSlot, BEHIND_RETRY_MS, behindRetryMs, bestLine, boardEyebrow, boardFooter, boardPath, count, dailyBars, dayIndex,
  finishHeight, gameEnded, headline, initial, isoWeek, MAX_BEHIND_TRIES, mondayOf,
  mergePage, nextFrom, noScoreLine, pct, placeLine, playersText, podiumLine, podiumOrder, points, pointsGap, pointsToNext, rankChangeText,
  rankDelta, rankLine, rankText, rankTip, rowLabel, sameBoard, scoreEquation, scoreTip, shownRange, tableColumns, tableHeadline, TABLE_FULL,
  TABLE_MID, topLine, topPercent, unrankedLine, weekColumns,
} from '../../src/leaderboard/board.js';

// Week 46 of 2026: Monday 9.11, shown on Wednesday 11.11.
const LIVE: BoardWeek = { start: '2026-11-09', day: '2026-11-11', final: false };
const CLOSED: BoardWeek = { start: '2026-11-02', day: '2026-11-06', final: true };

const row = (rank: number, o: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
  rank,
  name: `שחקן ${rank}`,
  returnPct: 1.5,
  score: 100 - rank,
  isMe: false,
  avatar: rank % 5,
  maxDrawdownPct: 1.2,
  returnRank: 90,
  stabilityRank: 60,
  rankChange: 0,
  days: [80, 81, null, null, null],
  ...o,
});

// You: #12 of 1,284, score 78.4, #11 has 78.9 (the mock-up's numbers).
const ME: LeaderboardMe = {
  rank: 12,
  players: 1284,
  score: 78.4,
  returnRank: 82,
  stabilityRank: 58,
  rankChange: 5,
  days: [],
  returnPct: 2.35,
  maxDrawdownPct: 1.8,
  ahead: { rank: 11, score: 78.9 },
};

const board = (o: Partial<LeaderboardView> = {}): LeaderboardView => ({
  clock: null,
  week: LIVE,
  players: 1284,
  me: ME,
  podium: [row(1), row(2), row(3)],
  view: 'top',
  rows: Array.from({ length: 20 }, (_, i) => row(i + 1)),
  from: 1,
  hasMore: true,
  pastWeeks: [],
  scoredAt: '2026-11-11T08:00:00.000Z',
  behind: false,
  ...o,
});

describe('numbers', () => {
  it('pct: a real minus sign, + for gains, nothing for zero', () => {
    expect(pct(2.35)).toBe('+2.35%');
    expect(pct(-1.8, 1)).toBe('−1.8%');
    expect(pct(0)).toBe('0.00%');
    expect(pct(-0, 1)).toBe('0.0%');   // a drawdown of 0 shown negated
  });

  it('points, count and the players text', () => {
    expect(points(78.44)).toBe('78.4');
    expect(points(100)).toBe('100.0');
    expect(count(1284)).toBe('1,284');
    expect(playersText(1)).toBe('שחקן אחד');
    expect(playersText(1284)).toBe('1,284 שחקנים');
  });

  it('pointsGap drops the float tail of two 2-decimal scores', () => {
    expect(78.5 - 78.4).toBeLessThan(0.1);   // the reason it exists: 0.09999999999999432
    expect(pointsGap(78.5, 78.4)).toBe(0.1);
    expect(pointsGap(78.9, 78.4)).toBe(0.5);
    expect(pointsGap(50.1, 50.1)).toBe(0);
  });

  it('rankText: a percentile rank to one decimal at most', () => {
    expect(rankText(82.5)).toBe('82.5');
    expect(rankText(61)).toBe('61');
    expect(rankText(82.47)).toBe('82.5');
    expect(rankText(99.96)).toBe('100');
    expect(rankText(0)).toBe('0');
  });

  it('scoreEquation: = only when the shown numbers add up to the shown score', () => {
    // 0.85 × 82.5 + 0.15 × 58.5 = 78.9 exactly (rounded to integers it would read 83 and 59, which give 79.4).
    expect(scoreEquation(82.5, 58.5, 78.9)).toBe('0.85 × 82.5 + 0.15 × 58.5 = 78.9');
    expect(scoreEquation(82, 58, 78.4)).toBe('0.85 × 82 + 0.15 × 58 = 78.4');
    // Two-decimal ranks whose shown values still add up: 82.5 and 58.5 give 78.9, as 78.88 shows.
    expect(scoreEquation(82.47, 58.53, 78.88)).toBe('0.85 × 82.5 + 0.15 × 58.5 = 78.9');
    // ...and ones that don't: 0.85 × 82.04 + 0.15 × 58.17 = 78.46 (shown 78.5), but 82 and 58.2 give 78.43 (78.4).
    expect(scoreEquation(82.04, 58.17, 78.46)).toBe('0.85 × 82 + 0.15 × 58.2 ≈ 78.5');
  });

  it('rankTip: the weight in the title, and the player\'s own rank read as a share of the others', () => {
    const r = rankTip('return', 82.47);
    expect(r.title).toBe('דירוג תשואה · 85% מהציון');
    expect(r.lines.at(-1)).toBe('אצלך 82.5: 82.5% מהשחקנים הרווחו כמוך או פחות.');
    expect(r.sum).toBeUndefined();
    const s = rankTip('stability', 12.5);
    expect(s.title).toBe('דירוג יציבות · 15% מהציון');
    expect(s.lines.at(-1)).toBe('אצלך 12.5: 12.5% מהשחקנים ירדו כמוך או יותר.');
  });

  it('scoreTip: the sum is the card\'s own equation', () => {
    expect(scoreTip(25, 12.5, 23.13).sum).toBe(scoreEquation(25, 12.5, 23.13));
    expect(scoreTip(25, 12.5, 23.13).sum).toBe('0.85 × 25 + 0.15 × 12.5 = 23.1');   // 21.25 + 1.875 = 23.125
  });
});

describe('the week', () => {
  it('isoWeek matches the clock\'s week number', () => {
    expect(isoWeek('2026-11-09')).toBe(46);
    expect(isoWeek('2026-11-13')).toBe(46);
    expect(isoWeek('2026-01-01')).toBe(1);    // a Thursday: week 1 of 2026
    expect(isoWeek('2025-12-29')).toBe(1);    // Monday of that week, still in 2025
    expect(isoWeek('2027-01-01')).toBe(53);   // a Friday: the last week of 2026
  });

  it('dayIndex: 0 = Monday, clamped to the five days', () => {
    expect(dayIndex(LIVE)).toBe(2);
    expect(dayIndex(CLOSED)).toBe(4);
    expect(dayIndex({ start: '2026-11-09', day: '2026-11-09', final: false })).toBe(0);
  });

  it('boardEyebrow: live, closed (D-032), and nothing scored', () => {
    expect(boardEyebrow(LIVE)).toBe('טבלת השבוע');
    expect(boardEyebrow(LIVE, true)).toBe('טבלת השבוע · שבוע 46');
    expect(boardEyebrow(CLOSED)).toBe('השבוע נסגר · השבוע החדש מתחיל בפתיחה');
    expect(boardEyebrow(CLOSED, true)).toBe('השבוע נסגר · השבוע החדש מתחיל בפתיחה');
    expect(boardEyebrow(null, true)).toBe('טבלת השבוע');
    // The last board of the game: no new week will start (gameEnded).
    expect(boardEyebrow(CLOSED, true, true)).toBe('המשחק הסתיים · זו הטבלה הסופית');
    expect(boardEyebrow(CLOSED, false, true)).not.toContain('בפתיחה');
    expect(boardEyebrow(LIVE, true, true)).toBe('טבלת השבוע · שבוע 46');   // only a final board can be the last
  });

  it('mondayOf: the Monday of a day', () => {
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-13')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');   // Sunday belongs to the week before
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });

  it('gameEnded: the final board of the week the price history ends in, or any final board at the end', () => {
    const clock = (at: string, endsAt: string | null): Pick<LiveClockView, 'at' | 'endsAt'> => ({
      at,
      endsAt: endsAt === null ? null : { at: endsAt, date: endsAt.slice(0, 10), weekday: 4, time: '09:59' },
    });
    const ENDS = '2026-11-05T07:59:00.000Z';   // Thursday 5.11, 09:59 Israel: in CLOSED's week
    expect(gameEnded(CLOSED, null)).toBe(false);
    expect(gameEnded(CLOSED, clock('2026-11-05T07:00:00.000Z', null))).toBe(false);          // no end set
    expect(gameEnded(CLOSED, clock('2026-11-04T21:00:00.000Z', ENDS))).toBe(true);           // its week's last event ran
    expect(gameEnded(CLOSED, clock(ENDS, ENDS))).toBe(true);
    expect(gameEnded({ ...CLOSED, final: false }, clock(ENDS, ENDS))).toBe(false);           // a live board isn't the last
    // The end is in a later week: this closed week is followed by a new one, until the clock reaches the end.
    const LATER = '2026-11-12T07:59:00.000Z';
    expect(gameEnded(CLOSED, clock('2026-11-09T07:00:00.000Z', LATER))).toBe(false);
    expect(gameEnded(CLOSED, clock(LATER, LATER))).toBe(true);
  });

  it('boardFooter: no "next week" once the game has ended', () => {
    expect(boardFooter(false)).toContain('השבוע הבא');
    expect(boardFooter(true)).not.toContain('השבוע הבא');
    expect(boardFooter(true)).toContain('הטבלה הסופית');
  });

  it('rankLine for the top bar', () => {
    expect(rankLine(12, 46)).toBe('מקום #12 · שבוע 46');
    expect(rankLine(12, null)).toBe('מקום #12');
    expect(rankLine(null, 46)).toBeNull();
  });
});

describe('your place', () => {
  it('pointsToNext: the gap to the place above, with one decimal', () => {
    expect(pointsToNext(ME)).toBe('עוד 0.5 נקודות למקום 11.');
    expect(pointsToNext({ score: 70, ahead: { rank: 3, score: 81.25 } })).toBe('עוד 11.3 נקודות למקום 3.');
  });

  it('pointsToNext: below what one decimal shows says "פחות מ־0.1"', () => {
    expect(pointsToNext({ score: 78.4, ahead: { rank: 11, score: 78.43 } })).toBe('פחות מ־0.1 נקודות למקום 11.');
    expect(pointsToNext({ score: 78.4, ahead: { rank: 11, score: 78.49 } })).toBe('פחות מ־0.1 נקודות למקום 11.');
    expect(pointsToNext({ score: 78.4, ahead: { rank: 11, score: 78.5 } })).toBe('עוד 0.1 נקודות למקום 11.');
  });

  it('pointsToNext: an equal score lost on the tie-break, and first place', () => {
    expect(pointsToNext({ score: 78.4, ahead: { rank: 11, score: 78.4 } })).toBe('ציון זהה למקום 11. הוא לפניך בשובר השוויון.');
    expect(pointsToNext({ score: 94.2, ahead: null })).toBeNull();
  });

  it('placeLine: live, first, and a closed week', () => {
    expect(placeLine(ME, false)).toBe('עוד 0.5 נקודות למקום 11.');
    expect(placeLine({ ...ME, rank: 1, ahead: null }, false)).toBe('אתה בראש הטבלה.');
    expect(placeLine(ME, true)).toBe('זה המקום הסופי שלך השבוע.');
    expect(placeLine({ ...ME, rank: 1, ahead: null }, true)).toBe('סיימת את השבוע בראש הטבלה.');
  });

  it('topPercent: never 0%, never above 100%', () => {
    expect(topPercent(12, 1284)).toBe(1);
    expect(topPercent(1, 1284)).toBe(1);
    expect(topPercent(128, 1284)).toBe(10);
    expect(topPercent(129, 1284)).toBe(11);
    expect(topPercent(1, 1)).toBe(100);
    expect(topPercent(1, 0)).toBeNull();
  });

  it('topLine: the top share in the top half, players behind below it', () => {
    expect(topLine(1, 1284)).toBe('אתה במקום הראשון.');
    expect(topLine(12, 1284)).toBe('אתה ב־1% העליון.');
    expect(topLine(642, 1284)).toBe('אתה ב־50% העליון.');
    expect(topLine(1000, 1284)).toBe('284 שחקנים מאחוריך.');
    expect(topLine(1283, 1284)).toBe('שחקן אחד מאחוריך.');
    expect(topLine(1284, 1284)).toBe('אתה בסוף הטבלה.');
  });

  it('headline: ranked, not ranked (live and closed), nothing scored', () => {
    expect(headline(board())).toEqual({ place: { rank: 12, players: 1284 }, lead: 'מקום 12 מתוך 1,284.', accent: 'עוד 0.5 נקודות למקום 11.' });
    expect(headline(board({ me: null }))).toEqual({ place: null, lead: 'עוד לא בדירוג השבוע.', accent: '1,284 שחקנים בטבלה כרגע.' });
    expect(headline(board({ me: null, week: CLOSED }))).toEqual({ place: null, lead: 'לא דורגת בשבוע שנסגר.', accent: '1,284 שחקנים בטבלה הסופית.' });
    expect(headline(board({ week: null, players: 0, me: null }))).toEqual({ place: null, lead: 'הטבלה עוד לא נפתחה.', accent: 'היא תתמלא אחרי שהציונים יחושבו.' });
  });

  it('not ranked in a live week, or before any board: how to get on (D-034)', () => {
    // Everyone holding a stock, or who traded this week, is ranked at every open and close, so a buy that fills
    // puts a player on the board at that open or close.
    expect(unrankedLine(LIVE)).toBe(
      'עוד לא בדירוג השבוע. כל מי שמחזיק מניה או שסחר השבוע נמצא בטבלה. תיכנס אליה כשקנייה שלך תתבצע, בפתיחה או בסגירה.',
    );
    expect(unrankedLine(null)).toBe('תיכנס לטבלה כשקנייה שלך תתבצע, בפתיחה או בסגירה.');
    expect(noScoreLine(false)).toBe('עוד אין לך ציון השבוע. הוא יופיע כאן כשקנייה שלך תתבצע, בפתיחה או בסגירה.');
    // The buy decides, never a day or a time; and no English words.
    for (const l of [unrankedLine(LIVE), unrankedLine(null), noScoreLine(false)]) {
      expect(l).not.toMatch(/מחר|בסוף|ביום/);
      expect(l).not.toMatch(/[A-Za-z]/);
    }
  });

  it('not ranked in a closed week: says so, and promises nothing', () => {
    expect(unrankedLine(CLOSED)).toBe('לא דורגת בשבוע שנסגר.');
    expect(noScoreLine(true)).toBe('לא דורגת בשבוע שנסגר.');
    const h = headline(board({ me: null, week: CLOSED }));
    const lines = [h.lead, h.accent, unrankedLine(CLOSED), noScoreLine(true), tableHeadline(board({ me: null, week: CLOSED })).accent];
    for (const l of lines) expect(l).not.toMatch(/תיכנס|תתבצע|יופיע|מחר|ביום/);
  });

  it('tableHeadline', () => {
    expect(tableHeadline(board())).toEqual({ lead: '1,284 שחקנים.', accent: 'אתה ב־1% העליון.' });
    expect(tableHeadline(board({ me: null }))).toEqual({ lead: '1,284 שחקנים.', accent: 'עוד לא בדירוג השבוע.' });
    expect(tableHeadline(board({ me: null, week: CLOSED }))).toEqual({ lead: '1,284 שחקנים.', accent: 'לא דורגת בשבוע הזה.' });
    expect(tableHeadline(board({ week: null, players: 0, me: null }))).toEqual({ lead: 'עוד אין שחקנים בטבלה.', accent: null });
  });
});

describe('rows', () => {
  it('rankDelta: up, down, no change, and the week\'s first day', () => {
    expect(rankDelta(5)).toEqual({ text: '▲ 5', tone: 'up', label: 'עלה 5 מקומות' });
    expect(rankDelta(1).label).toBe('עלה מקום אחד');
    expect(rankDelta(-2)).toEqual({ text: '▼ 2', tone: 'down', label: 'ירד 2 מקומות' });
    expect(rankDelta(-1).label).toBe('ירד מקום אחד');
    expect(rankDelta(0)).toEqual({ text: '–', tone: 'flat', label: 'בלי שינוי במקום' });
    expect(rankDelta(null)).toEqual({ text: '–', tone: 'flat', label: 'אין יום קודם השבוע' });
  });

  it('the change is against the previous scored day, never "since yesterday" (LD-09)', () => {
    expect(rankChangeText(5)).toBe('▲ 5 מהיום הקודם');
    expect(rankChangeText(-2)).toBe('▼ 2 מהיום הקודם');
    const change = tableColumns(TABLE_FULL).columns.find((c) => c.key === 'change');
    expect(change?.label).toBe('שינוי במקום');
  });

  it('initial: the first letter, whole, upper case for Latin', () => {
    expect(initial('ניב')).toBe('נ');
    expect(initial('  dana l.')).toBe('D');
    expect(initial('😀 Joy')).toBe('😀');
    expect(initial('   ')).toBe('?');
  });

  it('avatarSlot: 0..4 whatever comes in', () => {
    expect([0, 1, 2, 3, 4].map(avatarSlot)).toEqual([0, 1, 2, 3, 4]);
    expect(avatarSlot(7)).toBe(2);
    expect(avatarSlot(-1)).toBe(4);
    expect(avatarSlot(1.5)).toBe(0);
    expect(avatarSlot(Number.NaN)).toBe(0);
  });

  it('rowLabel: what a screen reader says', () => {
    expect(rowLabel(row(12, { name: 'ניב', isMe: true, score: 78.4, returnPct: 2.35, maxDrawdownPct: 1.8, rankChange: 5 }))).toBe(
      'מקום 12, ניב (אתה). ציון 78.4. תשואה +2.35%. ירידה מקסימלית −1.8%. עלה 5 מקומות.',
    );
  });

  it('dailyBars: five slots, null = no bar, today marked, heights clamped', () => {
    expect(dailyBars([61, 88, 120, null, null], 2)).toEqual([
      { height: 61, today: false },
      { height: 88, today: false },
      { height: 100, today: true },
      { height: null, today: false },
      { height: null, today: false },
    ]);
    expect(dailyBars([0], 0)[0]).toEqual({ height: 4, today: true });   // a zero score still shows a sliver
    expect(dailyBars([], 0).every((b) => b.height === null)).toBe(true);
  });
});

describe('tableColumns (LD-07)', () => {
  const keys = (w: number) => tableColumns(w).columns.map((c) => c.key);

  it('phones: place, player, score, and the second line', () => {
    expect(keys(390)).toEqual(['rank', 'player', 'score']);
    expect(tableColumns(390).subLine).toBe(true);
    expect(keys(TABLE_MID - 1)).toEqual(['rank', 'player', 'score']);
  });

  it('640 to 1099: return, drawdown and the change join', () => {
    expect(keys(TABLE_MID)).toEqual(['rank', 'player', 'score', 'return', 'drawdown', 'change']);
    expect(keys(TABLE_FULL - 1)).toEqual(['rank', 'player', 'score', 'return', 'drawdown', 'change']);
    expect(tableColumns(800).subLine).toBe(false);
  });

  it('1100 and up: the two ranks and the daily bars', () => {
    expect(keys(TABLE_FULL)).toEqual(['rank', 'player', 'score', 'return', 'drawdown', 'returnRank', 'stabilityRank', 'change', 'days']);
  });

  it('only the name flexes, and it keeps room at the narrowest width of each set', () => {
    for (const w of [320, 390, TABLE_MID, TABLE_FULL]) {
      const t = tableColumns(w);
      expect(t.columns.filter((c) => c.width === null).map((c) => c.key)).toEqual(['player']);
      const fixedWidth = t.columns.reduce((s, c) => s + (c.width ?? 0), 0) + t.gap * (t.columns.length - 1) + 2 * t.padX;
      const table = Math.min(w, 1200) - 32;   // the page's 16px gutters
      expect(table - fixedWidth).toBeGreaterThanOrEqual(120);
    }
  });
});

describe('podium', () => {
  it('podiumOrder: #2, #1, #3 (right to left), missing places left out', () => {
    expect(podiumOrder([row(1), row(2), row(3)]).map((r) => r.rank)).toEqual([2, 1, 3]);
    expect(podiumOrder([row(3), row(1), row(2)]).map((r) => r.rank)).toEqual([2, 1, 3]);
    expect(podiumOrder([row(1)]).map((r) => r.rank)).toEqual([1]);
    expect(podiumOrder([])).toEqual([]);
  });

  it('podiumLine', () => {
    const podium = [row(1), row(2), row(3, { score: 89 })];
    expect(podiumLine({ rank: 12, score: 78.4 }, podium)).toBe('הפער בינך לפודיום: 10.6 נקודות');
    expect(podiumLine({ rank: 2, score: 98 }, podium)).toBe('אתה על הפודיום.');
    expect(podiumLine({ rank: 4, score: 89 }, podium)).toBe('ציון זהה למקום 3.');
    expect(podiumLine({ rank: 4, score: 88.95 }, podium)).toBe('פחות מ־0.1 נקודות מהפודיום.');
    expect(podiumLine(null, podium)).toBeNull();
    expect(podiumLine({ rank: 4, score: 50 }, [row(1), row(2)])).toBeNull();
  });
});

describe('past weeks (LD-10)', () => {
  const past: PastWeekView[] = [
    { weekStart: '2026-11-02', rank: 19, players: 1200, score: 70.1 },
    { weekStart: '2026-10-26', rank: 27, players: 1100, score: 66 },
  ];

  it('finishHeight: against the week\'s own field, never below a sliver', () => {
    expect(finishHeight(1, 100)).toBe(100);
    expect(finishHeight(100, 100)).toBe(8);
    expect(finishHeight(51, 100)).toBe(50);
    expect(finishHeight(1, 0)).toBe(8);
  });

  it('weekColumns: oldest first, then the board\'s week while you\'re on it', () => {
    const cols = weekColumns(past, ME, LIVE);
    expect(cols.map((c) => c.label)).toEqual(['שבוע 44', 'שבוע 45', '46 · עכשיו']);
    expect(cols.map((c) => c.current)).toEqual([false, false, true]);
    expect(cols[2]).toMatchObject({ rank: 12, players: 1284, score: 78.4 });
    expect(cols[0].a11y).toBe('שבוע 44: מקום 27 מתוך 1,100, ציון 66.0');
    expect(weekColumns(past, ME, { ...LIVE, final: true })[2].label).toBe('46 · סופי');
    expect(weekColumns(past, null, LIVE).map((c) => c.current)).toEqual([false, false]);
    expect(weekColumns([], null, null)).toEqual([]);
  });

  it('bestLine', () => {
    expect(bestLine(weekColumns(past, ME, LIVE))).toBe('השיא שלך: מקום 12, השבוע.');
    expect(bestLine(weekColumns(past, null, LIVE))).toBe('השיא שלך: מקום 19, שבוע 45.');
    expect(bestLine([])).toBeNull();
  });
});

describe('paging (LD-03)', () => {
  it('boardPath: top from a place, around without one', () => {
    expect(boardPath('top')).toBe('/me/leaderboard?view=top&from=1');
    expect(boardPath('top', 21)).toBe('/me/leaderboard?view=top&from=21');
    expect(boardPath('around', 21)).toBe('/me/leaderboard?view=around');
  });

  it('nextFrom: the place after the last row', () => {
    expect(nextFrom(board())).toBe(21);
    expect(nextFrom(board({ rows: [row(7), row(8), row(17)] }))).toBe(18);
    expect(nextFrom(board({ rows: [] }))).toBe(1);
  });

  it('mergePage: appends, skips places already shown, keeps the view and the first place', () => {
    const around = board({ view: 'around', from: 7, rows: Array.from({ length: 11 }, (_, i) => row(i + 7)) });
    const page = board({ view: 'top', from: 17, rows: Array.from({ length: 20 }, (_, i) => row(i + 17)), hasMore: false, players: 1290 });
    const merged = mergePage(around, page);
    expect(merged.view).toBe('around');
    expect(merged.from).toBe(7);
    expect(merged.rows.map((r) => r.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 7));
    expect(new Set(merged.rows.map((r) => r.rank)).size).toBe(merged.rows.length);
    expect(merged.hasMore).toBe(false);
    expect(merged.players).toBe(1290);
  });

  it('sameBoard: a page fits under the rows only if it comes from the same ranking (scoredAt, D-034)', () => {
    const cur = board();
    const page2 = board({ from: 21, rows: Array.from({ length: 20 }, (_, i) => row(i + 21)) });
    expect(sameBoard(cur, page2)).toBe(true);   // the rows and the paging fields don't matter
    expect(sameBoard(cur, board({ week: { ...LIVE, final: true } }))).toBe(true);   // the week closing moves no place
    expect(sameBoard(cur, board({ behind: true }))).toBe(true);                       // behind is about the next ranking
    // The same day scored again, with the same count, podium and my row (two neighbours swapped places further
    // down): only scoredAt tells the rankings apart.
    expect(sameBoard(cur, board({ scoredAt: '2026-11-11T14:30:00.000Z' }))).toBe(false);
    expect(sameBoard(board({ scoredAt: null }), board({ scoredAt: null }))).toBe(true);
    // Another day, or a deleted player's rows.
    expect(sameBoard(cur, board({ week: { ...LIVE, day: '2026-11-12' } }))).toBe(false);
    expect(sameBoard(cur, board({ players: 1285 }))).toBe(false);
  });

  it('behindRetryMs: ask again in 15 to 30 s while the board is behind the clock, at most MAX_BEHIND_TRIES times', () => {
    expect(behindRetryMs(board({ behind: true }), 0, () => 0)).toBe(BEHIND_RETRY_MS);
    expect(BEHIND_RETRY_MS).toBe(15_000);
    const late = behindRetryMs(board({ behind: true }), 0, () => 0.99999);
    expect(late).toBeGreaterThan(BEHIND_RETRY_MS);
    expect(late).toBeLessThan(2 * BEHIND_RETRY_MS);
    expect(behindRetryMs(board({ behind: true }), MAX_BEHIND_TRIES - 1, () => 0.5)).toBe(22_500);
    expect(behindRetryMs(board({ behind: true }), MAX_BEHIND_TRIES)).toBeNull();
    expect(behindRetryMs(board({ behind: false }), 0)).toBeNull();
  });

  it('shownRange', () => {
    expect(shownRange(board().rows)).toBe('1–20');
    expect(shownRange([row(7)])).toBe('7');
    expect(shownRange([])).toBeNull();
  });
});
