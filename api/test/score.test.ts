// The weekly score as pure functions (api/src/game/score.ts, D-034): the percentiles, the score, the places,
// who is ranked, the numbers they're ranked on and the week's last event. No database. The SQL that writes the
// board (api/src/scoring.ts) is compared with these functions in scoring.test.ts.
//
// Ranks and scores are bigints at 2 decimals (10000n = 100.00); returns and drawdowns at 4 (PCT).

import { describe, expect, it } from 'vitest';
import {
  compareBytes, comparePlaces, isLastEventOfWeek, isRanked, percentile, RANK_MAX, type RankInput, scoreOf, scorePlayers,
  weekNumbers,
} from '../src/game/score.js';
import { format, parse, SCALE } from '../src/game/fixed.js';
import { eventsBetween } from '../src/game/clock.js';
import { makeCalendar, type Market, type MarketEvent, NO_CLOSURES } from '../src/game/marketHours.js';
import { addDays, ISRAEL, zonedToInstant } from '../src/game/time.js';
import { weekReturnPct } from '../src/game/week.js';

const p = (s: string) => parse(s, SCALE.PCT);
const r2 = (v: bigint) => format(v, 2);

// A ranked player: return and drawdown in % (strings, exact), sign-up in microseconds.
function player(uid: string, returnPct: string, drawdown: string, createdAtUs = 0n): RankInput {
  return { uid, createdAtUs, returnPct: p(returnPct), maxDrawdownPct: p(drawdown) };
}

// The board as strings, in place order: [uid, return rank, stability rank, score, place].
function board(players: RankInput[]) {
  return scorePlayers(players).map((s) => [s.uid, r2(s.returnRank), r2(s.stabilityRank), r2(s.score), s.place]);
}

// ---------- the brief's formula, by hand ----------

describe('the score', () => {
  it('reproduces the brief exactly on a worked example', () => {
    // Five players. N − 1 = 4 others each, so every percentile is a multiple of 25.
    //          return   drawdown
    //   a      +3.00%   1.00%
    //   b      +1.00%   0.00%
    //   c      +1.00%   2.50%
    //   d       0.00%   0.00%
    //   e      −2.00%   4.00%
    // Return rank = 100 × (others with a return ≤ mine) / 4:
    //   a: b, c, d, e = 4 → 100     b: c (tie), d, e = 3 → 75     c: b (tie), d, e = 3 → 75
    //   d: e = 1 → 25                e: none → 0
    // Stability rank = 100 × (others with a drawdown ≥ mine) / 4:
    //   a: c, e = 2 → 50   b: a, c, d (tie), e = 4 → 100   c: e = 1 → 25   d: a, b (tie), c, e = 4 → 100   e: 0
    // Score = 0.85 × return rank + 0.15 × stability rank:
    //   a: 85 + 7.5 = 92.50   b: 63.75 + 15 = 78.75   c: 63.75 + 3.75 = 67.50   d: 21.25 + 15 = 36.25   e: 0
    expect(board([
      player('c', '1', '2.5'), player('e', '-2', '4'), player('a', '3', '1'), player('d', '0', '0'), player('b', '1', '0'),
    ])).toEqual([
      ['a', '100.00', '50.00', '92.50', 1],
      ['b', '75.00', '100.00', '78.75', 2],
      ['c', '75.00', '25.00', '67.50', 3],
      ['d', '25.00', '100.00', '36.25', 4],
      ['e', '0.00', '0.00', '0.00', 5],
    ]);
  });

  it('ties share the higher percentile, like places 1, 2, 2, 4', () => {
    // Returns 5, 2, 2, −1: the two at 2% each did at least as well as 2 of the 3 others → 66.67, not 33.33 or 50.
    const s = scorePlayers([player('w', '5', '0'), player('x', '2', '0'), player('y', '2', '0'), player('z', '-1', '0')]);
    expect(s.map((x) => [x.uid, r2(x.returnRank), r2(x.stabilityRank)])).toEqual([
      ['w', '100.00', '100.00'], ['x', '66.67', '100.00'], ['y', '66.67', '100.00'], ['z', '0.00', '100.00'],
    ]);
  });

  it('one player: 100, 100, 100 and place 1', () => {
    expect(board([player('solo', '-7.5', '12')])).toEqual([['solo', '100.00', '100.00', '100.00', 1]]);
  });

  it('two players', () => {
    // The better return gets 100 and the other 0; the smaller drop gets 100 and the other 0.
    expect(board([player('slow', '1', '0'), player('fast', '4', '3')])).toEqual([
      ['fast', '100.00', '0.00', '85.00', 1],
      ['slow', '0.00', '100.00', '15.00', 2],
    ]);
    // Equal on both: both 100, and the earlier sign-up first.
    expect(board([player('late', '1', '1', 20n), player('early', '1', '1', 10n)])).toEqual([
      ['early', '100.00', '100.00', '100.00', 1],
      ['late', '100.00', '100.00', '100.00', 2],
    ]);
  });

  it('everyone equal: all 100, places by sign-up, then uid in byte order', () => {
    // 'Z' (0x5A) < 'y' (0x79) < 'z' (0x7A) in byte order, unlike a dictionary order. x signed up last.
    expect(board([player('z', '0', '0', 1n), player('x', '0', '0', 2n), player('y', '0', '0', 1n), player('Z', '0', '0', 1n)]))
      .toEqual([
        ['Z', '100.00', '100.00', '100.00', 1],
        ['y', '100.00', '100.00', '100.00', 2],
        ['z', '100.00', '100.00', '100.00', 3],
        ['x', '100.00', '100.00', '100.00', 4],
      ]);
  });

  it('an equal score goes to the higher % return', () => {
    // 21 players, returns 0..20 % (player k beats k of the 20 others: return rank 5k). P = 10 % (rank 50) has the
    // smallest drop (stability 100); Q = 13 % (rank 65) has 3 bigger drops (stability 15).
    // P: 0.85 × 50 + 0.15 × 100 = 57.50.   Q: 0.85 × 65 + 0.15 × 15 = 55.25 + 2.25 = 57.50. Q is ahead.
    const players = Array.from({ length: 21 }, (_, k) => {
      const uid = k === 10 ? 'P' : k === 13 ? 'Q' : `k${String(k).padStart(2, '0')}`;
      const drawdown = k === 10 ? '0' : k === 13 ? '5' : k >= 18 ? String(k - 12) : '1';   // 18, 19, 20 drop 6, 7, 8 %
      return player(uid, String(k), drawdown);
    });
    const s = scorePlayers(players);
    const P = s.find((x) => x.uid === 'P')!;
    const Q = s.find((x) => x.uid === 'Q')!;
    expect([r2(P.returnRank), r2(P.stabilityRank), r2(P.score)]).toEqual(['50.00', '100.00', '57.50']);
    expect([r2(Q.returnRank), r2(Q.stabilityRank), r2(Q.score)]).toEqual(['65.00', '15.00', '57.50']);
    expect(Q.place).toBe(P.place - 1);
  });

  it('comparePlaces: score, then % return, then the smaller drawdown, then the earlier sign-up, then uid', () => {
    const base = { uid: 'm', createdAtUs: 5n, returnPct: p('1'), maxDrawdownPct: p('1'), score: 5000n };
    const sorted = (xs: (typeof base)[]) => [...xs].sort(comparePlaces).map((x) => x.uid);
    expect(sorted([{ ...base, uid: 'lo', score: 4999n }, { ...base, uid: 'hi', score: 5001n }])).toEqual(['hi', 'lo']);
    expect(sorted([{ ...base, uid: 'lo', returnPct: p('0.9999') }, { ...base, uid: 'hi' }])).toEqual(['hi', 'lo']);
    expect(sorted([{ ...base, uid: 'deep', maxDrawdownPct: p('1.0001') }, { ...base, uid: 'flat' }])).toEqual(['flat', 'deep']);
    // Microseconds count: 1 µs earlier wins.
    expect(sorted([{ ...base, uid: 'a', createdAtUs: 6n }, { ...base, uid: 'b', createdAtUs: 5n }])).toEqual(['b', 'a']);
    expect(sorted([{ ...base, uid: 'b' }, { ...base, uid: 'B' }, { ...base, uid: 'a' }, { ...base, uid: '_' }]))
      .toEqual(['B', '_', 'a', 'b']);
  });

  it('compareBytes is UTF-8 byte order (COLLATE "C")', () => {
    expect(compareBytes('a', 'a')).toBe(0);
    expect(compareBytes('B', 'a')).toBeLessThan(0);
    expect(compareBytes('ab', 'a')).toBeGreaterThan(0);
    expect(compareBytes('Z9', 'Za')).toBeLessThan(0);
    // Above the BMP: UTF-16 code units would put U+FFFD after U+1F600's surrogates; UTF-8 bytes put it before.
    expect(compareBytes('�', '😀')).toBeLessThan(0);
  });
});

// ---------- percentiles and rounding ----------

describe('percentile and scoreOf', () => {
  it('100 for the best, 0 for a worst that is alone at the bottom, 100 for a board of one', () => {
    expect(percentile(9, 10)).toBe(RANK_MAX);
    expect(percentile(0, 10)).toBe(0n);
    expect(percentile(0, 1)).toBe(RANK_MAX);
  });

  it('rounds half away from zero to 2 decimals, exactly', () => {
    expect(r2(percentile(1, 33))).toBe('3.13');    // 100 / 32 = 3.125 (truncation or half-even would give 3.12)
    expect(r2(percentile(3, 33))).toBe('9.38');    // 9.375
    expect(r2(percentile(1, 4))).toBe('33.33');    // 33.333…
    expect(r2(percentile(2, 4))).toBe('66.67');    // 66.666…
    expect(r2(percentile(1, 1001))).toBe('0.10');  // 0.1 exactly
    expect(r2(percentile(1, 30001))).toBe('0.00'); // 0.00333…
    expect(r2(percentile(1, 201))).toBe('0.50');   // 0.5
    expect(r2(percentile(1, 401))).toBe('0.25');
    expect(r2(percentile(1, 801))).toBe('0.13');   // 0.125
  });

  it('the score is taken from the rounded ranks, half away from zero', () => {
    expect(r2(scoreOf(10n, 0n))).toBe('0.09');           // 0.85 × 0.10 = 0.085
    expect(r2(scoreOf(0n, 10n))).toBe('0.02');           // 0.15 × 0.10 = 0.015
    expect(r2(scoreOf(0n, 3n))).toBe('0.00');            // 0.0045
    expect(r2(scoreOf(10n, 10000n))).toBe('15.09');      // 0.085 + 15
    expect(r2(scoreOf(3333n, 6667n))).toBe('38.33');     // 28.3305 + 10.0005 = 38.331
    expect(r2(scoreOf(313n, 313n))).toBe('3.13');
    expect(r2(scoreOf(RANK_MAX, RANK_MAX))).toBe('100.00');
    expect(scoreOf(0n, 0n)).toBe(0n);
  });

  it('refuses impossible counts', () => {
    expect(() => percentile(-1, 3)).toThrow(RangeError);
    expect(() => percentile(3, 3)).toThrow(RangeError);
    expect(() => percentile(0, 0)).toThrow(RangeError);
    expect(() => percentile(0.5, 3)).toThrow(RangeError);
    expect(() => scorePlayers([player('a', '0', '0'), player('a', '1', '0')])).toThrow('twice');
  });

  it('an empty board is empty', () => {
    expect(scorePlayers([])).toEqual([]);
  });
});

// ---------- against the definition, on random boards ----------

// A small seeded generator (mulberry32), so a failing board can be replayed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('scorePlayers on random tie-heavy boards', () => {
  it('matches the definition counted pair by pair, and places are 1..N', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const n = 1 + Math.floor(rand() * 60);
      const returns = ['-3', '-0.0001', '0', '0', '0.0001', '1.25', '7'];
      const drops = ['0', '0', '0', '0.5', '1.2', '9.9999'];
      const players = Array.from({ length: n }, (_, i) =>
        player(`u${i}`, returns[Math.floor(rand() * returns.length)], drops[Math.floor(rand() * drops.length)],
          BigInt(Math.floor(rand() * 3))));
      const s = scorePlayers(players);
      expect(s.map((x) => x.place)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      for (const x of s) {
        const others = players.filter((o) => o.uid !== x.uid);
        const notBetter = others.filter((o) => o.returnPct <= x.returnPct).length;
        const notSmaller = others.filter((o) => o.maxDrawdownPct >= x.maxDrawdownPct).length;
        // The definition in plain numbers: round_half_away(100 × k / (N − 1), 2), via 10000k / (N − 1) in 0.01s.
        const expected = (k: number) => (n === 1 ? 10000n : (2n * 10000n * BigInt(k) + BigInt(n - 1)) / (2n * BigInt(n - 1)));
        expect(x.returnRank, `seed ${seed} ${x.uid}`).toBe(expected(notBetter));
        expect(x.stabilityRank, `seed ${seed} ${x.uid}`).toBe(expected(notSmaller));
        expect(x.score).toBe((2n * (85n * x.returnRank + 15n * x.stabilityRank) + 100n) / 200n);
      }
      // The best return and the smallest drop always get 100; places follow comparePlaces.
      const best = s.reduce((a, b) => (b.returnPct > a.returnPct ? b : a));
      const calm = s.reduce((a, b) => (b.maxDrawdownPct < a.maxDrawdownPct ? b : a));
      expect(best.returnRank).toBe(RANK_MAX);
      expect(calm.stabilityRank).toBe(RANK_MAX);
      for (let i = 1; i < s.length; i++) expect(comparePlaces(s[i - 1], s[i])).toBeLessThan(0);
      // A worst return held by one player alone gets 0.
      const worst = s.filter((x) => x.returnPct === s.reduce((a, b) => (b.returnPct < a.returnPct ? b : a)).returnPct);
      if (worst.length === 1 && n > 1) expect(worst[0].returnRank).toBe(0n);
    }
  });
});

// ---------- who is ranked, on which numbers ----------

describe('isRanked', () => {
  const W = '2026-11-09';
  it('this week\'s totals, or a stock held now', () => {
    expect(isRanked({ weekStart: W, hasOpenPosition: false }, W)).toBe(true);    // sold everything this week
    expect(isRanked({ weekStart: '2026-11-02', hasOpenPosition: true }, W)).toBe(true);   // not touched yet this week
    expect(isRanked({ weekStart: null, hasOpenPosition: true }, W)).toBe(true);
    expect(isRanked({ weekStart: '2026-11-02', hasOpenPosition: false }, W)).toBe(false);  // idle cash
    expect(isRanked({ weekStart: null, hasOpenPosition: false }, W)).toBe(false);          // a new sign-up
  });
});

describe('weekNumbers', () => {
  const W = '2026-11-09';
  const row = (start: string | null, value: string | null, equity: string, dd = '0') => ({
    weekStart: start,
    weekStartValue: value === null ? null : parse(value, SCALE.ILS),
    equity: parse(equity, SCALE.ILS),
    maxDrawdownPct: p(dd),
  });

  it('gives the same return as weekReturnPct(), and the stored drawdown', () => {
    const cases: [string, string][] = [
      ['1600000.00', '1600000.80'], ['1600000.00', '1599999.20'], ['1600000.00', '1600000.79'],
      ['1600000.00', '1599999.21'], ['1000000.00', '1012345.67'], ['3.00', '4.00'], ['999999.99', '0.00'],
      ['1000000.00', '1000000.00'],
    ];
    for (const [start, value] of cases) {
      const r = row(W, start, value, '1.5');
      const expected = weekReturnPct({ weekStart: W, weekStartValue: r.weekStartValue, peakValue: null, maxDrawdownPct: 0n, lastEventAt: null }, r.equity, W);
      expect(weekNumbers(r, W)).toEqual({ returnPct: expected, maxDrawdownPct: p('1.5') });
    }
    expect(format(weekNumbers(row(W, '1600000.00', '1600000.80'), W).returnPct, SCALE.PCT)).toBe('0.0001');   // half away
    expect(format(weekNumbers(row(W, '1600000.00', '1599999.20'), W).returnPct, SCALE.PCT)).toBe('-0.0001');
  });

  it('0 and 0 for totals that belong to another week, or no start value', () => {
    expect(weekNumbers(row('2026-11-02', '1000000.00', '1100000.00', '2'), W)).toEqual({ returnPct: 0n, maxDrawdownPct: 0n });
    expect(weekNumbers(row(null, null, '1000000.00'), W)).toEqual({ returnPct: 0n, maxDrawdownPct: 0n });
    expect(weekNumbers(row(W, null, '1000000.00', '0.5'), W)).toEqual({ returnPct: 0n, maxDrawdownPct: p('0.5') });
    expect(weekNumbers(row(W, '0.00', '1000000.00'), W)).toEqual({ returnPct: 0n, maxDrawdownPct: 0n });
  });
});

// ---------- the week's last event ----------

// Calendar: November 2026 (Israel UTC+2, New York UTC−5). TASE 10:00–17:30 (Friday to 13:50), US 16:30–23:00 Israel.
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';

function ev(market: Market, kind: 'open' | 'close', day: string): MarketEvent {
  const e = eventsBetween(zonedToInstant(day, 0, ISRAEL), zonedToInstant(addDays(day, 1), 0, ISRAEL), NO_CLOSURES)
    .find((x) => x.market === market && x.kind === kind);
  if (!e) throw new Error(`no ${market} ${kind} on ${day}`);
  return e;
}
const israel = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToInstant(day, h * 60 + m, ISRAEL);
};

describe('isLastEventOfWeek', () => {
  it('the Friday US close, from the calendar', () => {
    expect(isLastEventOfWeek(ev('US', 'close', FRI), NO_CLOSURES, null)).toBe(true);
    expect(isLastEventOfWeek(ev('US', 'open', FRI), NO_CLOSURES, null)).toBe(false);
    expect(isLastEventOfWeek(ev('TASE', 'close', FRI), NO_CLOSURES, null)).toBe(false);
    expect(isLastEventOfWeek(ev('US', 'close', THU), NO_CLOSURES, null)).toBe(false);
    expect(isLastEventOfWeek(ev('TASE', 'open', '2026-11-09'), NO_CLOSURES, null)).toBe(false);
  });

  it('follows the calendar: a US holiday on Friday ends the week at the TASE close, both closed at Thursday\'s', () => {
    const usFriday = makeCalendar([{ market: 'US', day: FRI, reason: 'Holiday' }]);
    expect(isLastEventOfWeek(ev('TASE', 'close', FRI), usFriday, null)).toBe(true);
    expect(isLastEventOfWeek(ev('TASE', 'open', FRI), usFriday, null)).toBe(false);
    const bothFriday = makeCalendar([{ market: 'US', day: FRI, reason: 'Holiday' }, { market: 'TASE', day: FRI, reason: 'חג' }]);
    expect(isLastEventOfWeek(ev('US', 'close', THU), bothFriday, null)).toBe(true);
    expect(isLastEventOfWeek(ev('TASE', 'close', THU), bothFriday, null)).toBe(false);
  });

  it('ends early at the world\'s end: the last event at or before ends_at', () => {
    const tClose = ev('TASE', 'close', WED).at;
    // Ends exactly at Wednesday's TASE close: that close still runs, and is the last.
    expect(isLastEventOfWeek(ev('TASE', 'close', WED), NO_CLOSURES, tClose)).toBe(true);
    expect(isLastEventOfWeek(ev('US', 'open', WED), NO_CLOSURES, tClose)).toBe(false);
    expect(isLastEventOfWeek(ev('TASE', 'open', WED), NO_CLOSURES, tClose)).toBe(false);
    // Ends at 20:00: the US close (23:00) never runs.
    expect(isLastEventOfWeek(ev('TASE', 'close', WED), NO_CLOSURES, israel(WED, '20:00'))).toBe(true);
    // An end before the event (it can't run after it anyway), and an end after the week: the calendar decides.
    expect(isLastEventOfWeek(ev('TASE', 'close', WED), NO_CLOSURES, israel(WED, '12:00'))).toBe(true);
    expect(isLastEventOfWeek(ev('US', 'close', THU), NO_CLOSURES, israel('2026-11-20', '12:00'))).toBe(false);
    expect(isLastEventOfWeek(ev('US', 'close', FRI), NO_CLOSURES, israel('2026-11-20', '12:00'))).toBe(true);
  });

  it('a close at the same instant as an open comes first, so the close is not last', () => {
    // A fixture calendar can't put two events on one instant, so the rule is checked on a made-up close at the US
    // open's instant: the open after it is still to come.
    const usOpen = ev('US', 'open', FRI);
    expect(isLastEventOfWeek({ kind: 'close', at: usOpen.at }, NO_CLOSURES, usOpen.at)).toBe(false);
    expect(isLastEventOfWeek({ kind: 'open', at: usOpen.at }, NO_CLOSURES, usOpen.at)).toBe(true);
  });
});
