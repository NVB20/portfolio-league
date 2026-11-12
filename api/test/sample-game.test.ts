// The dev-only sample game (D-038): the plan behind `npm run seed:sample-game`. Pure, no database.
// The script itself (scripts/seed-sample-game.ts) plays this plan through the real sendOrder and runner; it was run
// by hand against a private local database.

import { describe, expect, it } from 'vitest';
import { parse, SCALE } from '../src/game/fixed.js';
import { addDays, ISRAEL, zonedParts, zonedToInstant } from '../src/game/time.js';
import { mulberry32, SAMPLE_UIDS } from '../src/sampleBoard.js';
import {
  dayIndex,
  decide,
  GAME_DAYS,
  MARKET_OF,
  NOW_MARGIN_MIN,
  parseGameArgs,
  type Persona,
  planPersonas,
  planPlayer,
  type PlayerView,
  realInstant,
  realOfWorld,
  signupMinute,
  usageFor,
  worldInstant,
} from '../src/sampleGame.js';

// The world's first month as the local database has it: 27.11.2023 is a Monday; weekends never trade.
const START = '2023-11-27';
const weekday = (k: number) => {
  const w = new Date(`${addDays(START, k)}T12:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6;
};

const personas = planPersonas();
const plans = personas.map((p) => planPlayer(p, weekday));
const sends = (i: number) => plans[i].reduce((n, d) => n + d.sends.length, 0);

describe('planPersonas: the 40 players', () => {
  it('is one player per sample uid, the same on every run', () => {
    expect(personas.map((p) => p.uid)).toEqual([...SAMPLE_UIDS]);
    expect(planPersonas()).toEqual(personas);
  });

  it('sends about 30 orders each over the month', () => {
    const avg = personas.reduce((s, p) => s + p.orders, 0) / personas.length;
    expect(avg).toBeGreaterThanOrEqual(27);
    expect(avg).toBeLessThanOrEqual(33);
    for (const p of personas) expect(p.orders).toBeGreaterThanOrEqual(9);
  });

  it('joins like a launch: most in the first three days, the rest before the last week', () => {
    expect(personas.filter((p) => p.joinDay <= 2)).toHaveLength(22);
    for (const p of personas) expect(p.joinDay).toBeLessThan(GAME_DAYS - 5);
  });

  it('trades a few favorite stocks in both markets, and some leave early', () => {
    for (const p of personas) {
      expect(p.favorites.some((s) => MARKET_OF.get(s) === 'TASE')).toBe(true);
      expect(p.favorites.some((s) => MARKET_OF.get(s) === 'US')).toBe(true);
      if (p.churnDay !== null) expect(p.churnDay).toBeGreaterThan(p.joinDay);
    }
    expect(personas.filter((p) => p.churnDay !== null)).toHaveLength(10);
  });

  it('has players who never use a stop loss, and players who often do', () => {
    const never = personas.filter((p) => p.stopShare === 0).length;
    expect(never).toBeGreaterThanOrEqual(8);
    expect(never).toBeLessThanOrEqual(24);
    expect(personas.some((p) => p.stopShare >= 0.5)).toBe(true);
  });
});

describe('planPlayer: when each player comes and sends', () => {
  it('sends exactly the planned orders, never before joining', () => {
    personas.forEach((p, i) => {
      expect(sends(i)).toBe(p.orders);
      for (const d of plans[i]) if (d.day < p.joinDay) expect(d.sessions).toEqual([]);
    });
  });

  it('builds a first portfolio on the join day: a visit and 3 to 5 sends', () => {
    personas.forEach((p, i) => {
      const join = plans[i][p.joinDay];
      expect(join.sessions.length).toBeGreaterThan(0);
      expect(join.sends.length).toBeGreaterThanOrEqual(Math.min(3, p.orders));
    });
  });

  it('puts every send after a visit start, in time order, inside the day', () => {
    for (const plan of plans) {
      for (const d of plan) {
        if (d.sends.length > 0) expect(d.sessions[0]).toBeLessThanOrEqual(d.sends[0].minute);
        const minutes = d.sends.map((s) => s.minute);
        expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
        for (const m of [...minutes, ...d.sessions]) {
          expect(m).toBeGreaterThanOrEqual(0);
          expect(m).toBeLessThan(1440);
        }
        // Visits more than 30 minutes apart (D-026).
        for (let k = 1; k < d.sessions.length; k++) expect(d.sessions[k] - d.sessions[k - 1]).toBeGreaterThanOrEqual(31);
      }
    }
  });

  it('never sends before the world clock starts on day 0 (09:00)', () => {
    for (const plan of plans) for (const s of plan[0].sends) expect(s.minute).toBeGreaterThan(9 * 60);
  });

  it('comes back more the day after joining than a week after (D-026)', () => {
    const back = (n: number) => personas.filter((p, i) => plans[i][p.joinDay + n]?.sessions.length > 0).length;
    expect(back(1)).toBeGreaterThan(back(7));
  });

  it('leaves some orders waiting: on the last day, the last send is after both markets closed', () => {
    const last = plans.map((plan) => plan[GAME_DAYS - 1]).filter((d) => d.sends.length > 0);
    expect(last.length).toBeGreaterThan(0);
    for (const d of last) expect(d.sends.at(-1)!.minute).toBeGreaterThan(23 * 60);
  });

  it('trades mostly on trading days', () => {
    const all = plans.flat();
    const off = all.filter((d) => !weekday(d.day)).reduce((n, d) => n + d.sends.length, 0);
    const total = all.reduce((n, d) => n + d.sends.length, 0);
    expect(off / total).toBeLessThan(0.1);
  });

  it('signs up a little before the first visit', () => {
    personas.forEach((p, i) => {
      const m = signupMinute(p, plans[i]);
      expect(m).toBeLessThanOrEqual(plans[i][p.joinDay].sessions[0]);
      expect(plans[i][p.joinDay].sessions[0] - m).toBeLessThanOrEqual(3);
    });
  });
});

describe('usageFor: what the app would have reported (D-036)', () => {
  const p = personas[0];

  it('is nothing on a day without a visit', () => {
    const u = usageFor(p, 3, 0, 0);
    expect(u.confirms).toEqual({ opened: 0, backed: 0 });
    for (const x of Object.values(u.pages)) expect(x).toEqual({ views: 0, ms: 0 });
  });

  it('opens the popup for every order sent, plus the ones backed out of', () => {
    for (let day = 0; day < 10; day++) {
      const u = usageFor(p, day, 2, 4);
      expect(u.confirms.opened).toBe(4 + u.confirms.backed);
      expect(u.pages.trade.views).toBeGreaterThanOrEqual(u.confirms.opened);
      expect(u.pages.dashboard.views).toBeGreaterThanOrEqual(2);
      for (const x of Object.values(u.pages)) {
        expect(Number.isInteger(x.views) && Number.isInteger(x.ms)).toBe(true);
        expect(x.ms === 0).toBe(x.views === 0);
      }
    }
  });
});

describe('decide: one order', () => {
  const player = (over: Partial<Persona> = {}): Persona => ({ ...personas[0], style: 'balanced', stopShare: 0, ...over });
  const cashOnly: PlayerView = { availableCash: 1_000_000, equity: 1_000_000, holdings: [], pendingBuys: new Map() };
  const price = () => 50;

  it('buys on the join day, within the cash and the 20% limit, in the asked market', () => {
    for (let s = 0; s < 50; s++) {
      const d = decide(player({ style: 'aggressive' }), mulberry32(s), cashOnly, 'US', price, true);
      expect(d?.side).toBe('buy');
      if (d?.side !== 'buy') continue;
      expect(MARKET_OF.get(d.symbol)).toBe('US');
      expect(Number(d.amountIls)).toBeGreaterThanOrEqual(100);
      expect(Number(d.amountIls)).toBeLessThan(200_000);
    }
  });

  it('counts what is held and pending in the stock toward the 20%', () => {
    const symbol = player().favorites.find((s) => MARKET_OF.get(s) === 'TASE')!;
    const others = player().favorites.filter((s) => s !== symbol);
    const view: PlayerView = {
      ...cashOnly,
      holdings: [{ symbol, market: 'TASE', units: '1000.00000000', freeUnits: '1000.00000000', value: 150_000, cost: 150_000 }],
      pendingBuys: new Map([[symbol, 49_950], ...others.map((s): [string, number] => [s, 200_000])]),
    };
    // Every favorite is full, so only a random other stock (20% of the time) can be bought.
    for (let s = 0; s < 30; s++) {
      const d = decide(player(), mulberry32(s), view, 'TASE', price, true);
      if (d) expect(d.symbol).not.toBe(symbol);
    }
  });

  it('sets a stop loss below the latest close when the player uses one', () => {
    const d = decide(player({ stopShare: 1 }), mulberry32(7), cashOnly, 'TASE', () => 12.34, true);
    expect(d?.side).toBe('buy');
    if (d?.side === 'buy') {
      expect(d.stopPrice).not.toBeNull();
      expect(Number(d.stopPrice)).toBeLessThan(12.34);
      expect(d.stopPrice).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('sells free units only, all of them or a part worth at least ₪150', () => {
    const view: PlayerView = {
      availableCash: 50,   // nothing to buy with, so it always sells
      equity: 1_000_000,
      holdings: [{ symbol: 'TEVA', market: 'TASE', units: '300.12345678', freeUnits: '200.00000001', value: 12_000, cost: 10_000 }],
      pendingBuys: new Map(),
    };
    for (let s = 0; s < 40; s++) {
      const d = decide(player(), mulberry32(s), view, 'TASE', price, false);
      expect(d?.side).toBe('sell');
      if (d?.side !== 'sell') continue;
      const units = parse(d.units, SCALE.UNITS);
      expect(units > 0n && units <= parse('200.00000001', SCALE.UNITS)).toBe(true);
    }
  });

  it('gives up when nothing fits: no cash and nothing to sell', () => {
    const broke: PlayerView = { availableCash: 50, equity: 1_000_000, holdings: [], pendingBuys: new Map() };
    expect(decide(player(), mulberry32(1), broke, 'US', price, false)).toBeNull();
  });
});

describe('the two clocks', () => {
  const realNow = zonedToInstant('2026-11-11', 23 * 60 + 45, ISRAEL);
  const firstReal = addDays('2026-11-11', -(GAME_DAYS - 1));

  it('counts game days from the world start', () => {
    expect(dayIndex(START, START)).toBe(0);
    expect(dayIndex(START, '2023-12-26')).toBe(29);
  });

  it('shows world day k on real day k, at the same Israel clock time', () => {
    const at = realInstant(firstReal, 3, 14 * 60 + 5, 9, realNow);
    expect(zonedParts(at, ISRAEL)).toMatchObject({ date: addDays(firstReal, 3), minutes: 14 * 60 + 5 });
    expect(at.getUTCSeconds()).toBe(9);
    const world = worldInstant(START, 3, 14 * 60 + 5, 9);
    expect(realOfWorld(START, firstReal, world, realNow)).toEqual(at);
  });

  it('squeezes today into the part already over, never closer to now than the margin', () => {
    const early = zonedToInstant('2026-11-11', 8 * 60, ISRAEL);   // 08:00: most of the day is still ahead
    for (const minute of [0, 600, 1200, 1439]) {
      const at = realInstant(firstReal, GAME_DAYS - 1, minute, 59, early);
      expect(zonedParts(at, ISRAEL).date).toBe('2026-11-11');
      expect(at.getTime()).toBeLessThanOrEqual(early.getTime() - NOW_MARGIN_MIN * 60_000);
    }
    // Order is kept: a later world minute is never earlier in real time.
    const a = realInstant(firstReal, GAME_DAYS - 1, 600, 0, early);
    const b = realInstant(firstReal, GAME_DAYS - 1, 1200, 0, early);
    expect(a.getTime()).toBeLessThan(b.getTime());
  });

  it('keeps today on its date when run just after midnight', () => {
    const justAfter = zonedToInstant('2026-11-12', 2, ISRAEL);   // 00:02
    const first = addDays('2026-11-12', -(GAME_DAYS - 1));
    for (const minute of [0, 720, 1439]) {
      const at = realInstant(first, GAME_DAYS - 1, minute, 30, justAfter);
      expect(zonedParts(at, ISRAEL).date).toBe('2026-11-12');
      expect(at.getTime()).toBeLessThanOrEqual(justAfter.getTime());
    }
  });
});

describe('parseGameArgs', () => {
  it('reads --clear and --force, and refuses the rest', () => {
    expect(parseGameArgs([])).toEqual({ clear: false, force: false });
    expect(parseGameArgs(['--force'])).toEqual({ clear: false, force: true });
    expect(parseGameArgs(['--clear'])).toEqual({ clear: true, force: false });
    expect(parseGameArgs(['--clear', '--force'])).toHaveProperty('error');
    expect(parseGameArgs(['--days=5'])).toHaveProperty('error');
  });
});
