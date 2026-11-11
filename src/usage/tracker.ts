// The app's usage counter (D-036): views and time per player page, and the trade screen's confirm popup (opened,
// closed without sending). It only counts; usePresence sends what it counted with each check-in (POST /me/seen),
// and the server caps every report and adds it to daily totals. No React, no network, no clock of its own: every
// call gets `now` (Date.now()), so api/test/usage-tracker.test.ts can test it with made-up times.
//
// Time counts only while all of these hold:
//   - a tracked page is open (the 4 player pages; admin pages and login are null and never count)
//   - the app is in the foreground (pause / resume, from AppState)
//   - on the web, someone used the page in the last IDLE_MS. A tab left open overnight doesn't count as 8 hours:
//     the minutes after the last input count (the player may be reading), the rest is dropped, and the next input
//     starts the count again. Navigation and coming back to the app count as input.
// On phones nothing listens for input, so idle can't be told apart from reading: all foreground time counts.
//
// The import is type-only and ends in .js: api/test/usage-tracker.test.ts loads this file under the API's NodeNext
// type check (src/usage/package.json marks the folder as ES modules), as with src/journal/journal.ts.

import type { UsagePage, UsageReport } from '../../api/src/contract.js';

export const IDLE_MS = 5 * 60_000;

type PageCount = { views: number; ms: number };

// pathname (usePathname) → the tracked page, or null for everything else.
const PAGES: ReadonlyMap<string, UsagePage> = new Map([
  ['/dashboard', 'dashboard'],
  ['/trade', 'trade'],
  ['/journal', 'journal'],
  ['/leaderboard', 'leaderboard'],
]);

// '/trade?symbol=TEVA' and '/trade/' are the trade page too. A Map, not an object, so 'constructor' isn't a page.
export function pageOf(pathname: string): UsagePage | null {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '');
  return PAGES.get(path) ?? null;
}

export class UsageTracker {
  private page: UsagePage | null = null;
  private paused = false;
  private idleCutoff = false;   // on only while something listens for input (the web hook)
  private lastInput = 0;
  private countedTo = 0;        // time before this is already counted (or dropped)
  private pages: Partial<Record<UsagePage, PageCount>> = {};
  private opened = 0;
  private backed = 0;

  // A route change. Leaving a page counts its time up to now; a different tracked page is a new view.
  startPage(page: UsagePage | null, now: number): void {
    this.accrue(now);
    if (page !== null && page !== this.page) this.count(page).views += 1;
    this.page = page;
    this.lastInput = now;
  }

  // The app went to the background (or the tab was hidden): nothing counts until resume.
  pause(now: number): void {
    this.accrue(now);
    this.paused = true;
  }

  // Back in the foreground. Switching back to the app is the player's own act, so it counts as input.
  resume(now: number): void {
    this.accrue(now);
    this.paused = false;
    this.lastInput = now;
  }

  // Someone used the page (pointer, keys, wheel, touch, scroll). The hook throttles these to one every few seconds.
  activity(now: number): void {
    this.accrue(now);   // first, so an idle stretch before this input is cut off, not counted
    this.lastInput = now;
  }

  // The web hook turns the idle cut-off on while it listens for input, and off when it stops listening.
  watchInput(on: boolean, now: number): void {
    this.accrue(now);
    this.idleCutoff = on;
    this.lastInput = now;
  }

  confirmOpened(): void {
    this.opened += 1;
  }

  confirmBacked(): void {
    this.backed += 1;
  }

  // Everything since the last take, as POST /me/seen's body; the counts start again from zero.
  // null = nothing to send (the check-in then goes without a body).
  take(now: number): UsageReport | null {
    this.accrue(now);
    const pages: UsageReport['pages'] = {};
    let any = false;
    for (const [page, c] of Object.entries(this.pages) as [UsagePage, PageCount][]) {
      const ms = Math.round(c.ms);
      if (c.views === 0 && ms === 0) continue;
      pages[page] = { views: c.views, ms };
      any = true;
    }
    const report: UsageReport = {};
    if (any) report.pages = pages;
    if (this.opened > 0 || this.backed > 0) report.confirms = { opened: this.opened, backed: this.backed };
    this.pages = {};
    this.opened = 0;
    this.backed = 0;
    return report.pages || report.confirms ? report : null;
  }

  // A check-in that failed: its report goes back, and the next check-in sends it with whatever came since.
  // The server caps time per request, so after several failures in a row some of it may be scaled down.
  putBack(report: UsageReport): void {
    for (const [page, c] of Object.entries(report.pages ?? {}) as [UsagePage, PageCount][]) {
      const mine = this.count(page);
      mine.views += c.views;
      mine.ms += c.ms;
    }
    this.opened += report.confirms?.opened ?? 0;
    this.backed += report.confirms?.backed ?? 0;
  }

  // Adds the time from the last counted moment up to now to the open page, never past lastInput + IDLE_MS
  // when the idle cut-off is on. Called before every change, so each stretch is counted under the state it ran in.
  private accrue(now: number): void {
    if (this.page !== null && !this.paused) {
      const end = this.idleCutoff ? Math.min(now, this.lastInput + IDLE_MS) : now;
      if (end > this.countedTo) this.count(this.page).ms += end - this.countedTo;
    }
    // now, not the larger of the two: if the device clock is set back, counting goes on from the new time
    // instead of stopping until the clock catches up.
    this.countedTo = now;
  }

  private count(page: UsagePage): PageCount {
    return (this.pages[page] ??= { views: 0, ms: 0 });
  }
}

// A check-in that failed: whether its report goes back to the tracker for the next one. Back when the server
// wrote none of it: the request never got there (offline), or the server answered with an error (it writes the
// usage in one statement, as its last step, so a 401, 404 or 5xx wrote none of it). Dropped when sending it again
// would be wrong:
//   - 400: refused as malformed. Sent again it would be refused again, and every check-in after it with it, so
//     the player would never count as online.
//   - the app's 10 s timeout: the server may still finish after the app gave up and write the report, so sending
//     it again could count it twice. Losing a minute is the smaller error.
// status = the server's answer, null when none came. timedOut = the app stopped waiting (an AbortError).
export function keepAfterFailure(status: number | null, timedOut: boolean): boolean {
  return !timedOut && status !== 400;
}

// The trade screen's confirm popup, for the admin's funnel. Every opening counts once. An opening counts as backed
// out at most once, and only when it closes without a send by the player's choice: back, a tap outside, Escape, a
// change to the order, or leaving the screen with it open. Once the order went out, nothing that closes the popup
// is a back-out: not leaving the screen while the send is on its way, and not closing it after a send that got no
// answer (the order may be stored, though the popup stays open to send again). A definite refusal that keeps the
// popup open (the rate limit, an id conflict) stored nothing, so that opening can still be backed out of.
export class ConfirmFunnel {
  private open = false;
  private sending = 0;           // this opening's sends on their way
  private maybeStored = false;   // one of this opening's sends was stored, or got no answer

  constructor(private readonly counter: Pick<UsageTracker, 'confirmOpened' | 'confirmBacked'>) {}

  opened(): void {
    if (this.open) return;
    this.open = true;
    this.maybeStored = false;
    this.counter.confirmOpened();
  }

  // A press on send. Call what it returns once the answer is in, with whether the order may now be stored
  // (stored, or no answer). A press that sent nothing (a send already on its way) is false.
  send(): (maybeStored: boolean) => void {
    this.sending += 1;
    let done = false;
    return (maybeStored) => {
      if (done) return;
      done = true;
      this.sending -= 1;
      if (maybeStored) this.maybeStored = true;
    };
  }

  // The popup closed (or the screen it was open on did). backedOut = by the player's choice, as above; a send, or
  // a failed send that closes it with a toast, is false.
  closed(backedOut: boolean): void {
    if (backedOut && this.open && this.sending === 0 && !this.maybeStored) this.counter.confirmBacked();
    this.open = false;
  }
}

// The one tracker the app shares: useUsageTracking feeds it, TradeScreen counts the popup, usePresence sends it.
export const usage = new UsageTracker();
