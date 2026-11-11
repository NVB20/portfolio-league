// The app's usage counter (src/usage/tracker.ts, D-036): views and time per player page, the idle cut-off,
// pause/resume, and the confirm popup's counts. Pure: every call gets a made-up `now`, nothing touches a clock,
// the network or the database. The last block runs the tracker's reports through the server's own check.
// The app file is an ES module for this NodeNext check because of src/usage/package.json ("type": "module").

import { describe, expect, it } from 'vitest';
import { ConfirmFunnel, IDLE_MS, keepAfterFailure, pageOf, UsageTracker } from '../../src/usage/tracker.js';
import { MAX_REPORT_MS, parseUsageText } from '../src/usage.js';

const S = 1000;
const MIN = 60 * S;

describe('pageOf', () => {
  it('maps the 4 player pages', () => {
    expect(pageOf('/dashboard')).toBe('dashboard');
    expect(pageOf('/trade')).toBe('trade');
    expect(pageOf('/journal')).toBe('journal');
    expect(pageOf('/leaderboard')).toBe('leaderboard');
  });

  it('ignores a query string, a hash and trailing slashes', () => {
    expect(pageOf('/trade?symbol=TEVA')).toBe('trade');
    expect(pageOf('/journal/?filter=pending')).toBe('journal');
    expect(pageOf('/dashboard#top')).toBe('dashboard');
    expect(pageOf('/leaderboard//')).toBe('leaderboard');
  });

  it('is null for everything else: admin pages, login, the root, unknown paths', () => {
    for (const path of ['/admin-dashboard', '/admin-monitoring', '/login', '/', '', '/trade/x', '/dashboards', 'constructor', '/constructor']) {
      expect(pageOf(path)).toBeNull();
    }
  });
});

describe('UsageTracker', () => {
  it('has nothing to send at first', () => {
    expect(new UsageTracker().take(0)).toBeNull();
  });

  it('counts a view per change to a tracked page, and the time on each', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.startPage('trade', 10 * S);
    t.startPage('dashboard', 25 * S);
    expect(t.take(30 * S)).toEqual({
      pages: { dashboard: { views: 2, ms: 15 * S }, trade: { views: 1, ms: 15 * S } },
    });
  });

  it('the same page again is not a new view', () => {
    const t = new UsageTracker();
    t.startPage('trade', 0);
    t.startPage('trade', 5 * S);
    expect(t.take(10 * S)).toEqual({ pages: { trade: { views: 1, ms: 10 * S } } });
  });

  it('untracked pages (null) get no views and no time', () => {
    const t = new UsageTracker();
    t.startPage(null, 0);
    expect(t.take(MIN)).toBeNull();

    t.startPage('leaderboard', MIN);
    t.startPage(null, MIN + 20 * S);   // an admin page
    t.startPage('leaderboard', 3 * MIN);
    expect(t.take(3 * MIN + 5 * S)).toEqual({ pages: { leaderboard: { views: 2, ms: 25 * S } } });
  });

  it('counts nothing while paused, and goes on after resume', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.pause(10 * S);
    t.resume(10 * MIN);
    expect(t.take(10 * MIN + 20 * S)).toEqual({ pages: { dashboard: { views: 1, ms: 30 * S } } });
  });

  it('a take while paused sends the time before the pause, then nothing more', () => {
    const t = new UsageTracker();
    t.startPage('trade', 0);
    t.pause(40 * S);
    expect(t.take(5 * MIN)).toEqual({ pages: { trade: { views: 1, ms: 40 * S } } });
    expect(t.take(10 * MIN)).toBeNull();
  });

  describe('the idle cut-off (on while the web listens for input)', () => {
    it('without it (phones), all foreground time counts', () => {
      const t = new UsageTracker();
      t.startPage('trade', 0);
      expect(t.take(20 * MIN)).toEqual({ pages: { trade: { views: 1, ms: 20 * MIN } } });
    });

    it('stops counting IDLE_MS after the last input', () => {
      const t = new UsageTracker();
      t.watchInput(true, 0);
      t.startPage('dashboard', 0);
      t.activity(MIN);
      expect(t.take(MIN + 3 * 60 * MIN)).toEqual({ pages: { dashboard: { views: 1, ms: MIN + IDLE_MS } } });
    });

    it('drops the idle time, and the next input starts the count again', () => {
      const t = new UsageTracker();
      t.watchInput(true, 0);
      t.startPage('journal', 0);
      t.activity(30 * MIN);   // 5 minutes counted, 25 dropped
      expect(t.take(31 * MIN)).toEqual({ pages: { journal: { views: 1, ms: IDLE_MS + MIN } } });
    });

    it('a take in the middle changes nothing: the cut-off still holds', () => {
      const t = new UsageTracker();
      t.watchInput(true, 0);
      t.startPage('trade', 0);
      expect(t.take(2 * MIN)).toEqual({ pages: { trade: { views: 1, ms: 2 * MIN } } });
      expect(t.take(4 * MIN)).toEqual({ pages: { trade: { views: 0, ms: 2 * MIN } } });
      expect(t.take(10 * MIN)).toEqual({ pages: { trade: { views: 0, ms: IDLE_MS - 4 * MIN } } });
      expect(t.take(20 * MIN)).toBeNull();
    });

    it('navigation and coming back to the app count as input', () => {
      const t = new UsageTracker();
      t.watchInput(true, 0);
      t.startPage('dashboard', 0);
      t.startPage('trade', 4 * MIN);   // input at 4 min: trade counts until 9 min
      expect(t.take(20 * MIN)).toEqual({
        pages: { dashboard: { views: 1, ms: 4 * MIN }, trade: { views: 1, ms: IDLE_MS } },
      });
      t.pause(21 * MIN);
      t.resume(30 * MIN);   // input at 30 min: counts until 35 min
      expect(t.take(40 * MIN)).toEqual({ pages: { trade: { views: 0, ms: IDLE_MS } } });
    });

    it('turning it off counts all foreground time again', () => {
      const t = new UsageTracker();
      t.watchInput(true, 0);
      t.startPage('leaderboard', 0);
      t.watchInput(false, 10 * MIN);   // 5 of these 10 minutes count
      expect(t.take(20 * MIN)).toEqual({ pages: { leaderboard: { views: 1, ms: IDLE_MS + 10 * MIN } } });
    });
  });

  it('take resets the counts', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.confirmOpened();
    expect(t.take(MIN)).toEqual({ pages: { dashboard: { views: 1, ms: MIN } }, confirms: { opened: 1, backed: 0 } });
    // Still on the dashboard: only the time since that take.
    expect(t.take(MIN + 10 * S)).toEqual({ pages: { dashboard: { views: 0, ms: 10 * S } } });
    t.startPage(null, MIN + 10 * S);
    expect(t.take(5 * MIN)).toBeNull();
  });

  it('rounds the time to whole milliseconds', () => {
    const t = new UsageTracker();
    t.startPage('trade', 0.2);
    expect(t.take(1000.9)).toEqual({ pages: { trade: { views: 1, ms: 1001 } } });
  });

  it('counts the confirm popup: opened and backed out', () => {
    const t = new UsageTracker();
    t.confirmOpened();
    t.confirmBacked();
    t.confirmOpened();
    expect(t.take(0)).toEqual({ confirms: { opened: 2, backed: 1 } });
    expect(t.take(0)).toBeNull();
  });

  it('putBack merges a failed report with what came since', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.confirmOpened();
    t.confirmBacked();
    const failed = t.take(MIN);
    expect(failed).not.toBeNull();

    t.startPage('trade', MIN);
    t.confirmOpened();
    t.putBack(failed!);
    expect(t.take(MIN + 30 * S)).toEqual({
      pages: { dashboard: { views: 1, ms: MIN }, trade: { views: 1, ms: 30 * S } },
      confirms: { opened: 2, backed: 1 },
    });
  });

  it('putBack of a report with only one part keeps the other', () => {
    const t = new UsageTracker();
    t.putBack({ confirms: { opened: 1, backed: 1 } });
    t.putBack({ pages: { journal: { views: 2, ms: 500 } } });
    expect(t.take(0)).toEqual({ pages: { journal: { views: 2, ms: 500 } }, confirms: { opened: 1, backed: 1 } });
  });

  it('a device clock set back neither counts negative time nor stops counting', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 10 * MIN);
    expect(t.take(5 * MIN)).toEqual({ pages: { dashboard: { views: 1, ms: 0 } } });
    expect(t.take(6 * MIN)).toEqual({ pages: { dashboard: { views: 0, ms: MIN } } });
  });
});

// ---------- the confirm popup's funnel (TradeScreen) ----------

describe('ConfirmFunnel', () => {
  // A funnel over a fresh tracker; `counts()` = what the next check-in would report for the popup.
  const setup = () => {
    const t = new UsageTracker();
    return { f: new ConfirmFunnel(t), counts: () => t.take(0)?.confirms ?? { opened: 0, backed: 0 } };
  };

  it('an opening closed by the player is one back-out, however many ways it closes', () => {
    const { f, counts } = setup();
    f.opened();
    f.opened();          // the second send button while it is open: still one opening
    f.closed(true);      // back
    f.closed(true);      // the order change that follows, and leaving the screen
    expect(counts()).toEqual({ opened: 1, backed: 1 });
  });

  it('a stored order, or a send that closes the popup with a toast, is no back-out', () => {
    const { f, counts } = setup();
    f.opened();
    f.send()(true);      // stored
    f.closed(false);
    f.opened();
    f.send()(false);     // refused: the popup closes with a toast
    f.closed(false);
    expect(counts()).toEqual({ opened: 2, backed: 0 });
  });

  it('leaving the screen while the send is on its way is no back-out, whatever the answer', () => {
    const { f, counts } = setup();
    f.opened();
    const answered = f.send();
    f.closed(true);      // the screen unmounts mid-send
    answered(true);
    expect(counts()).toEqual({ opened: 1, backed: 0 });
  });

  it('after a send with no answer the order may be stored: closing the popup then is no back-out', () => {
    const { f, counts } = setup();
    f.opened();
    f.send()(true);      // no answer: the popup stays open to send again
    f.closed(true);      // "חזור", the only way out once the preview blocks a resend
    expect(counts()).toEqual({ opened: 1, backed: 0 });
  });

  it('a definite refusal that keeps the popup open stored nothing: backing out after it counts', () => {
    const { f, counts } = setup();
    f.opened();
    f.send()(false);     // rate limit
    f.closed(true);
    expect(counts()).toEqual({ opened: 1, backed: 1 });
  });

  it('a press while a send is on its way sends nothing and changes nothing', () => {
    const { f, counts } = setup();
    f.opened();
    const first = f.send();
    f.send()(false);     // the double click: useSendOrder returns null
    f.closed(true);
    first(true);
    expect(counts()).toEqual({ opened: 1, backed: 0 });
  });

  it('a new opening starts clean: a send from an earlier opening does not shield it', () => {
    const { f, counts } = setup();
    f.opened();
    f.send()(true);
    f.closed(false);
    f.opened();
    f.closed(true);
    expect(counts()).toEqual({ opened: 2, backed: 1 });
  });

  it('closing while nothing is open counts nothing', () => {
    const { f, counts } = setup();
    f.closed(true);
    expect(counts()).toEqual({ opened: 0, backed: 0 });
  });
});

// ---------- a failed check-in ----------

describe('keepAfterFailure', () => {
  it('puts the report back when the server wrote none of it', () => {
    expect(keepAfterFailure(null, false)).toBe(true);   // offline: never got there
    for (const status of [401, 404, 429, 500, 503]) expect(keepAfterFailure(status, false)).toBe(true);
  });

  it('drops it after a 400 (refused again forever) and after the timeout (the server may still write it)', () => {
    expect(keepAfterFailure(400, false)).toBe(false);
    expect(keepAfterFailure(null, true)).toBe(false);
  });
});

// ---------- the tracker's report through the server's check (src/usage/tracker.ts → api/src/usage.ts) ----------
// The two sides are written apart, so this pins the request body the app sends to what POST /me/seen accepts.
// Each report goes through JSON first, as it does on the way to the server.

describe('a report from the tracker passes the server check', () => {
  const asSent = (report: unknown) => parseUsageText(JSON.stringify(report));

  it('a minute on two pages and the popup: accepted exactly as sent', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.startPage('trade', 20.4 * S);
    t.confirmOpened();
    t.confirmBacked();
    const report = t.take(MIN);
    expect(report).not.toBeNull();
    expect(asSent(report)).toEqual({ ok: true, report });
  });

  it('every page in one report: accepted exactly as sent', () => {
    const t = new UsageTracker();
    t.startPage('dashboard', 0);
    t.startPage('trade', 10 * S);
    t.startPage('journal', 25 * S);
    t.startPage('leaderboard', 40 * S);
    const report = t.take(MIN);
    expect(Object.keys(report?.pages ?? {}).sort()).toEqual(['dashboard', 'journal', 'leaderboard', 'trade']);
    expect(asSent(report)).toEqual({ ok: true, report });
  });

  it('after failed check-ins the merged report is over the cap: scaled down, never refused', () => {
    const t = new UsageTracker();
    t.startPage('trade', 0);
    t.putBack(t.take(MIN)!);       // the first check-in failed
    t.putBack(t.take(2 * MIN)!);   // and the second
    const merged = t.take(3 * MIN);
    expect(merged).toEqual({ pages: { trade: { views: 1, ms: 3 * MIN } } });
    expect(asSent(merged)).toEqual({ ok: true, report: { pages: { trade: { views: 1, ms: MAX_REPORT_MS } } } });
  });
});
