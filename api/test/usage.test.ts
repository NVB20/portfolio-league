// parseUsage (D-036): the optional body of POST /me/seen, checked and capped before anything is written.
// Pure: no database.

import { describe, expect, it } from 'vitest';
import { hasUsage, MAX_REPORT_COUNT, MAX_REPORT_MS, parseUsage, parseUsageText, USAGE_PAGES } from '../src/usage.js';
import type { UsageReport } from '../src/contract.js';

// The report of a body that must be accepted.
function ok(body: unknown): UsageReport {
  const out = parseUsage(body);
  if (!out.ok) throw new Error(`refused: ${out.error}`);
  return out.report;
}

// The error of a body that must be refused.
function refused(body: unknown): string {
  const out = parseUsage(body);
  if (out.ok) throw new Error(`accepted: ${JSON.stringify(out.report)}`);
  return out.error;
}

const totalMs = (r: UsageReport) => Object.values(r.pages ?? {}).reduce((sum, p) => sum + p.ms, 0);

describe('parseUsage: what counts as an empty report', () => {
  it('no body, or null, is a plain check-in', () => {
    expect(ok(undefined)).toEqual({});
    expect(ok(null)).toEqual({});
  });

  it('an empty object is a plain check-in', () => {
    expect(ok({})).toEqual({});
    expect(hasUsage(ok({}))).toBe(false);
  });

  it('ignores unknown top-level fields: a client cannot claim a visit', () => {
    expect(ok({ newVisit: true, open: true })).toEqual({});
  });

  it('pages and confirms set to null count as absent', () => {
    expect(ok({ pages: null, confirms: null })).toEqual({});
  });

  it('leaves out pages with no view and no time, and confirms with nothing in them', () => {
    expect(ok({ pages: { trade: { views: 0, ms: 0 } }, confirms: { opened: 0, backed: 0 } })).toEqual({});
  });

  it('keeps a page with time and no view, or a view and no time', () => {
    expect(ok({ pages: { trade: { views: 0, ms: 4000 }, journal: { views: 1, ms: 0 } } })).toEqual({
      pages: { trade: { views: 0, ms: 4000 }, journal: { views: 1, ms: 0 } },
    });
  });
});

describe('parseUsage: a normal report', () => {
  it('passes through as sent', () => {
    const body = {
      pages: {
        dashboard: { views: 1, ms: 12_000 },
        trade: { views: 2, ms: 40_000 },
        journal: { views: 1, ms: 5_000 },
        leaderboard: { views: 3, ms: 3_000 },
      },
      confirms: { opened: 2, backed: 1 },
    };
    expect(ok(body)).toEqual(body);
    expect(hasUsage(ok(body))).toBe(true);
  });

  it('confirms alone are worth writing', () => {
    expect(hasUsage(ok({ confirms: { opened: 0, backed: 1 } }))).toBe(true);
  });

  it('a back-out without an open in the same report is fine (the popup opened before the last check-in)', () => {
    expect(ok({ confirms: { opened: 0, backed: 1 } })).toEqual({ confirms: { opened: 0, backed: 1 } });
  });

  it('tracks exactly the four player pages', () => {
    expect([...USAGE_PAGES].sort()).toEqual(['dashboard', 'journal', 'leaderboard', 'trade']);
  });
});

describe('parseUsage: unknown pages and prototype keys', () => {
  it('drops pages it does not track (admin pages, login, made-up names)', () => {
    const r = ok({
      pages: {
        'admin-dashboard': { views: 5, ms: 10_000 },
        'admin-monitoring': { views: 5, ms: 10_000 },
        login: { views: 1, ms: 1_000 },
        trade: { views: 1, ms: 2_000 },
      },
    });
    expect(r).toEqual({ pages: { trade: { views: 1, ms: 2_000 } } });
  });

  it('drops an unknown page even when its value is not { views, ms }', () => {
    expect(ok({ pages: { admin: 'lots', trade: { views: 1, ms: 1 } } })).toEqual({ pages: { trade: { views: 1, ms: 1 } } });
  });

  it('a "__proto__" page from JSON is dropped and changes no prototype', () => {
    const body = JSON.parse('{"pages":{"__proto__":{"views":5,"ms":100},"trade":{"views":1,"ms":10}}}');
    const r = ok(body);
    expect(r).toEqual({ pages: { trade: { views: 1, ms: 10 } } });
    expect(Object.getPrototypeOf(r.pages)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).views).toBeUndefined();
  });

  it('"constructor", "toString" and "hasOwnProperty" are not pages', () => {
    expect(ok({ pages: { constructor: { views: 1, ms: 1 }, toString: { views: 1, ms: 1 }, hasOwnProperty: { views: 1, ms: 1 } } })).toEqual({});
  });

  it('a top-level "__proto__" from JSON carries nothing in', () => {
    expect(ok(JSON.parse('{"__proto__":{"pages":{"trade":{"views":1,"ms":10}}}}'))).toEqual({});
  });

  it('reads only own fields, never inherited ones', () => {
    const inherited = Object.create({ pages: { trade: { views: 1, ms: 10 } }, confirms: { opened: 1, backed: 1 } });
    expect(ok(inherited)).toEqual({});
    const entry = Object.create({ views: 1, ms: 10 });
    expect(refused({ pages: { trade: entry } })).toContain('pages.trade.views');
  });
});

describe('parseUsage: the caps', () => {
  it('caps views, opened and backed at 50 each', () => {
    const r = ok({ pages: { trade: { views: 1000, ms: 1 } }, confirms: { opened: 51, backed: 999_999 } });
    expect(r.pages?.trade?.views).toBe(MAX_REPORT_COUNT);
    expect(r.confirms).toEqual({ opened: MAX_REPORT_COUNT, backed: MAX_REPORT_COUNT });
  });

  it('a negative count or time counts as 0', () => {
    expect(ok({ pages: { trade: { views: -3, ms: -5000 } }, confirms: { opened: -1, backed: -1 } })).toEqual({});
    expect(ok({ pages: { trade: { views: -3, ms: 2000 } } })).toEqual({ pages: { trade: { views: 0, ms: 2000 } } });
  });

  it('cuts fractions', () => {
    expect(ok({ pages: { trade: { views: 2.9, ms: 1500.99 } }, confirms: { opened: 1.5, backed: 0.4 } })).toEqual({
      pages: { trade: { views: 2, ms: 1500 } },
      confirms: { opened: 1, backed: 0 },
    });
  });

  it('caps one page at 2 minutes', () => {
    expect(ok({ pages: { trade: { views: 1, ms: 500_000 } } }).pages?.trade?.ms).toBe(MAX_REPORT_MS);
  });

  it('exactly 2 minutes in total is kept as sent', () => {
    const r = ok({ pages: { trade: { views: 1, ms: 80_000 }, dashboard: { views: 1, ms: 40_000 } } });
    expect(r.pages).toEqual({ trade: { views: 1, ms: 80_000 }, dashboard: { views: 1, ms: 40_000 } });
  });

  it('over 2 minutes in total: every page shrinks by the same factor', () => {
    const r = ok({ pages: { trade: { views: 1, ms: 100_000 }, dashboard: { views: 1, ms: 50_000 } } });
    expect(r.pages).toEqual({ trade: { views: 1, ms: 80_000 }, dashboard: { views: 1, ms: 40_000 } });
    expect(totalMs(r)).toBe(MAX_REPORT_MS);
  });

  it('rounding down never lets the total pass the cap', () => {
    const r = ok({
      pages: { trade: { views: 1, ms: 50_000 }, dashboard: { views: 1, ms: 50_000 }, journal: { views: 1, ms: 50_001 } },
    });
    expect(totalMs(r)).toBeLessThanOrEqual(MAX_REPORT_MS);
    expect(totalMs(r)).toBeGreaterThan(MAX_REPORT_MS - 3);
    for (const p of Object.values(r.pages ?? {})) expect(Number.isInteger(p.ms)).toBe(true);
  });

  it('huge times are capped per page first, so the total never overflows to Infinity', () => {
    const r = ok({ pages: { trade: { views: 1, ms: 1e308 }, dashboard: { views: 1, ms: 1e308 } } });
    expect(r.pages).toEqual({ trade: { views: 1, ms: 60_000 }, dashboard: { views: 1, ms: 60_000 } });
  });

  it('a page whose time scales down to 0 keeps its views; one with nothing left is dropped', () => {
    const r = ok({
      pages: {
        trade: { views: 0, ms: 120_000 },
        journal: { views: 2, ms: 120_000 },
        dashboard: { views: 1, ms: 1 },
        leaderboard: { views: 0, ms: 1 },
      },
    });
    expect(r.pages?.dashboard).toEqual({ views: 1, ms: 0 });
    expect(r.pages?.leaderboard).toBeUndefined();
    expect(totalMs(r)).toBeLessThanOrEqual(MAX_REPORT_MS);
  });
});

describe('parseUsage: refusals (400, nothing written)', () => {
  it('a body that is not an object', () => {
    for (const body of [[], [{ pages: {} }], 'trade', 5, true]) expect(refused(body)).toBe('the body must be a JSON object');
  });

  it('pages that is not an object of page names', () => {
    for (const pages of [[], 'trade', 5, true]) expect(refused({ pages })).toContain('pages');
  });

  it('a tracked page that is not { views, ms }', () => {
    for (const entry of ['x', 5, [], true]) expect(refused({ pages: { trade: entry } })).toContain('pages.trade');
  });

  it('views or ms missing, or not a number', () => {
    expect(refused({ pages: { trade: { ms: 1000 } } })).toContain('pages.trade.views');
    expect(refused({ pages: { trade: { views: 1 } } })).toContain('pages.trade.ms');
    expect(refused({ pages: { trade: { views: '3', ms: 1000 } } })).toContain('pages.trade.views');
    expect(refused({ pages: { trade: { views: 1, ms: '1000' } } })).toContain('pages.trade.ms');
    expect(refused({ pages: { trade: { views: null, ms: 1000 } } })).toContain('pages.trade.views');
  });

  it('a number that is not finite', () => {
    expect(refused({ pages: { trade: { views: 1, ms: Infinity } } })).toContain('pages.trade.ms');
    expect(refused({ pages: { trade: { views: NaN, ms: 1 } } })).toContain('pages.trade.views');
    expect(refused({ confirms: { opened: -Infinity, backed: 0 } })).toContain('confirms.opened');
  });

  it('one bad page refuses the whole report, not just that page', () => {
    expect(parseUsage({ pages: { dashboard: { views: 1, ms: 10 }, trade: { views: 'x', ms: 10 } } }).ok).toBe(false);
  });

  it('confirms that is not { opened, backed }', () => {
    expect(refused({ confirms: 3 })).toContain('confirms');
    expect(refused({ confirms: [] })).toContain('confirms');
    expect(refused({ confirms: { opened: 1 } })).toContain('confirms.backed');
    expect(refused({ confirms: { backed: 1 } })).toContain('confirms.opened');
    expect(refused({ confirms: { opened: '1', backed: 0 } })).toContain('confirms.opened');
  });
});

describe('parseUsageText: the raw body', () => {
  it('an empty body is a plain check-in', () => {
    expect(parseUsageText('')).toEqual({ ok: true, report: {} });
    expect(parseUsageText('  \n')).toEqual({ ok: true, report: {} });
    expect(parseUsageText('null')).toEqual({ ok: true, report: {} });
  });

  it('text that is not JSON is refused', () => {
    expect(parseUsageText('not json')).toEqual({ ok: false, error: 'the body must be JSON' });
    expect(parseUsageText('{"pages":')).toEqual({ ok: false, error: 'the body must be JSON' });
  });

  it('an overflowing number in JSON (1e999 = Infinity) is refused', () => {
    expect(parseUsageText('{"pages":{"trade":{"views":1,"ms":1e999}}}').ok).toBe(false);
  });

  it('JSON of the wrong shape is refused', () => {
    expect(parseUsageText('[]')).toEqual({ ok: false, error: 'the body must be a JSON object' });
    expect(parseUsageText('"x"')).toEqual({ ok: false, error: 'the body must be a JSON object' });
  });

  it('a good report is read', () => {
    expect(parseUsageText('{"pages":{"journal":{"views":1,"ms":2500}}}')).toEqual({
      ok: true,
      report: { pages: { journal: { views: 1, ms: 2500 } } },
    });
  });
});
