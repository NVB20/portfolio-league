// The admin's clock moves and the per-minute ticker (D-017, D-021, D-027, D-030).
//   advance  jump to the next close of an open market, or to the next open when none is open
//   start    the clock runs at real speed from where it stands
//   stop     the clock freezes where it is now
//   ticker   every minute: a heartbeat, then run the opens and closes the running clock has passed
// A move runs every event it passes FIRST (runner.ts, under the runner's advisory lock), and only then moves
// the clock row and writes its admin_actions row, in ONE transaction: the log can't show a move that rolled
// back, or miss one that happened (D-027). While the events run, the effective now (worldNow) already follows
// world_clock.events_through, so an order sent mid-jump runs after the event that is running, not inside it.
// The rules (where a jump goes, the effective now) live in game/clock.ts; this file loads, calls and writes.

import type { Pool, PoolClient } from 'pg';
import type {
  AdminAction,
  ClockActionError,
  ClockActionErrorCode,
  ClockAdvanceResult,
  ClockRunCounts,
  ClockStartResult,
  ClockStopResult,
  LiveClockView,
} from './contract.js';
import { loadCalendar } from './calendar.js';
import { CLOCK_COLUMNS, type ClockSqlRow, clockView, effectiveNow, worldTime } from './dashboard.js';
import { jumpTarget } from './game/clock.js';
import type { Calendar } from './game/marketHours.js';
import { type RunSummary, runUntil, withRunnerLock } from './runner.js';

export const TICK_MS = 60_000;
const NO_END = new Date(8.64e15);   // the latest Date there is: a world with no ends_at

type Failure = { status: 409; body: ClockActionError };
export type ClockOutcome<T> = { status: 200; body: T } | Failure;

const ERRORS: Record<ClockActionErrorCode, { error: string; reason: string }> = {
  NO_WORLD: { error: 'the world has not started yet', reason: 'העולם עוד לא התחיל' },
  CLOCK_BUSY: {
    error: 'the runner is busy with an open or close; try again in a moment',
    reason: 'המנוע מריץ כרגע פתיחה או סגירה. נסו שוב בעוד רגע',
  },
  CLOCK_AT_END: {
    error: 'the clock is at the end of the price history',
    reason: 'השעון הגיע לסוף נתוני המחירים, אין לאן להתקדם',
  },
};

function fail(code: ClockActionErrorCode): Failure {
  return { status: 409, body: { ...ERRORS[code], code } };
}

function ok<T>(body: T): ClockOutcome<T> {
  return { status: 200, body };
}

// ---------- the admin's moves ----------

// Move 1 or 2 (D-017). Under the runner lock, so the ticker or a second click can't run events at the same
// time; busy = 409 CLOCK_BUSY at once rather than an HTTP request waiting behind a long event.
export async function advanceClock(db: Pool, uid: string): Promise<ClockOutcome<ClockAdvanceResult>> {
  // Loaded before taking a connection: a cold cache needs a second one (orders.ts does the same).
  const calendar = await loadCalendar(db);
  const out = await withRunnerLock(db, async (client): Promise<ClockOutcome<ClockAdvanceResult>> => {
    const row = await readClock(client);
    if (!row) return fail('NO_WORLD');
    const from = effectiveNow(row, calendar);
    const jump = jumpTarget(from, row.ends_at ?? NO_END, calendar);
    if (!jump) return fail('CLOCK_AT_END');

    const counts = countsOf(await runUntil(client, jump.to));
    const moved = await inTransaction(client, async () => {
      // A running clock keeps running from the target: its anchor's real time is now.
      const r = await updateClock(client, 'now_at = $1, real_at = now()', [jump.to]);
      await logAction(client, uid, jump.kind === 'to_close' ? 'clock_to_close' : 'clock_to_open', from, jump.to, counts);
      return r;
    });
    return ok({ kind: jump.kind, from: worldTime(from), to: worldTime(jump.to), ...counts, clock: liveClock(moved, calendar) });
  });
  return out ?? fail('CLOCK_BUSY');
}

// Runs nothing (no world time passes), so it needs no runner lock and is never busy. One transaction.
export async function startClock(db: Pool, uid: string): Promise<ClockOutcome<ClockStartResult>> {
  const calendar = await loadCalendar(db);
  const client = await db.connect();
  try {
    return await inTransaction(client, async (): Promise<ClockOutcome<ClockStartResult>> => {
      const row = (await client.query<ClockSqlRow>(`SELECT ${CLOCK_COLUMNS} FROM world_clock FOR UPDATE`)).rows[0];
      if (!row) return fail('NO_WORLD');
      if (row.running) return ok({ changed: false, clock: liveClock(row, calendar) });
      // From now on, world time = now_at + the real time since this moment (D-017).
      const started = await updateClock(client, 'running = TRUE, real_at = now()', []);
      await logAction(client, uid, 'clock_start', row.now_at, row.now_at, {});
      return ok({ changed: true, clock: liveClock(started, calendar) });
    });
  } finally {
    client.release();
  }
}

// Freezes the clock at the effective now of the moment the lock was taken, after running every event up to it.
export async function stopClock(db: Pool, uid: string): Promise<ClockOutcome<ClockStopResult>> {
  const calendar = await loadCalendar(db);
  const out = await withRunnerLock(db, async (client): Promise<ClockOutcome<ClockStopResult>> => {
    const row = await readClock(client);
    if (!row) return fail('NO_WORLD');
    if (!row.running) return ok({ changed: false, clock: liveClock(row, calendar) });
    const at = effectiveNow(row, calendar);

    const counts = countsOf(await runUntil(client, at));
    const frozen = await inTransaction(client, async () => {
      const r = await updateClock(client, 'now_at = $1, real_at = now(), running = FALSE', [at]);
      await logAction(client, uid, 'clock_stop', at, at, counts);
      return r;
    });
    return ok({ changed: true, at: worldTime(at), ...counts, clock: liveClock(frozen, calendar) });
  });
  return out ?? fail('CLOCK_BUSY');
}

// ---------- the ticker ----------

export type TickerOptions = {
  intervalMs?: number;
  // What a tick runs under the runner lock, up to the effective now. Tests pass a slow or failing fake.
  run?: (client: PoolClient, target: Date) => Promise<RunSummary>;
};

const runToTarget = (client: PoolClient, target: Date) => runUntil(client, target);

// The ticker's heartbeat, in real time. Written on every tick, even when nothing is due or the lock is busy,
// so the admin page can tell a quiet world from a ticker that stopped.
export async function heartbeat(db: Pool): Promise<void> {
  await db.query('UPDATE world_clock SET last_tick_at = now()');
}

// Runs whatever is due: an event a crash left unfinished, then every event up to the effective now (where the
// running clock is; a stopped clock has nothing new). null = another runner holds the lock (an admin move, or
// the ticker of another API instance): it is doing the same work.
export async function runDue(db: Pool, run = runToTarget): Promise<RunSummary | null> {
  const calendar = await loadCalendar(db);
  return withRunnerLock(db, async (client) => {
    const row = await readClock(client);
    if (!row) return { events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 };
    return run(client, effectiveNow(row, calendar));
  });
}

// Ticks at once, then every `intervalMs`. A tick whose predecessor is still running skips its run, so two runs
// never overlap; nothing is ever thrown out of the timer (a failed run is logged, and the next tick resumes the
// event at the step it stopped, D-021). Returns stop(), which resolves once the tick in progress is over.
export function startTicker(db: Pool, opts: TickerOptions = {}): () => Promise<void> {
  const intervalMs = opts.intervalMs ?? TICK_MS;
  const run = opts.run ?? runToTarget;
  let stopped = false;
  let beating = false;   // a heartbeat in flight: a slow database doesn't pile them up
  let running = false;   // a run in flight
  const inFlight = new Set<Promise<void>>();

  const tick = async () => {
    if (!beating) {
      beating = true;
      await heartbeat(db)
        .catch((err) => console.error('ticker: heartbeat failed', err))
        .finally(() => { beating = false; });
    }
    if (stopped || running) return;
    running = true;
    try {
      const s = await runDue(db, run);
      if (s && s.events > 0) {
        console.log(`ticker: ran ${s.events} event(s): ${s.ordersExecuted} orders executed, ${s.ordersRejected} rejected, ${s.playersUpdated} players updated`);
      }
    } catch (err) {
      console.error('ticker: run failed; the next tick resumes it', err);
    } finally {
      running = false;
    }
  };

  const fire = () => {
    if (stopped) return;
    const p = tick();   // never rejects: every failure inside is caught and logged
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const timer = setInterval(fire, intervalMs);
  timer.unref();   // the HTTP server keeps the process alive, not the ticker
  fire();          // at once: a restarted API resumes an unfinished event without waiting a minute
  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.all(inFlight);
  };
}

// ---------- helpers ----------

async function readClock(client: PoolClient): Promise<ClockSqlRow | null> {
  const { rows } = await client.query<ClockSqlRow>(`SELECT ${CLOCK_COLUMNS} FROM world_clock`);
  return rows[0] ?? null;
}

// One UPDATE of the single clock row (it takes the row lock that order sending waits on with FOR SHARE).
// RETURNING's now() is this transaction's start: the real_at just written, so the returned clock is exact.
async function updateClock(client: PoolClient, set: string, params: unknown[]): Promise<ClockSqlRow> {
  const { rows } = await client.query<ClockSqlRow>(`UPDATE world_clock SET ${set} RETURNING ${CLOCK_COLUMNS}`, params);
  if (!rows[0]) throw new Error('the world_clock row is gone');
  return rows[0];
}

async function logAction(
  client: PoolClient,
  uid: string,
  action: AdminAction,
  from: Date,
  to: Date,
  detail: ClockRunCounts | Record<string, never>,
): Promise<void> {
  await client.query(
    `INSERT INTO admin_actions (uid, action, world_from, world_to, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [uid, action, from, to, JSON.stringify(detail)],
  );
}

// The clock as the dashboard shows it (LiveClockView), from a clock row.
function liveClock(row: ClockSqlRow, calendar: Calendar): LiveClockView {
  return {
    ...clockView(effectiveNow(row, calendar), calendar),
    running: row.running,
    endsAt: row.ends_at ? worldTime(row.ends_at) : null,
  };
}

function countsOf(s: RunSummary): ClockRunCounts {
  return { events: s.events, ordersExecuted: s.ordersExecuted, ordersRejected: s.ordersRejected, playersUpdated: s.playersUpdated };
}

// BEGIN … COMMIT on the given client; any error rolls back and is thrown again, so the client is always clean.
async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
