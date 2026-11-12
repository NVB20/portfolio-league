// The daily streak in Postgres (D-039). The rules are pure (game/streak.ts); this file reads and writes the five
// users.streak_* columns. "Today" is Postgres's own real Israel date, so every API instance agrees on it and the
// phone's clock plays no part. The world clock plays no part either.

import type { Pool, PoolClient } from 'pg';
import type { StreakView } from './contract.js';
import { countDay, type Streak, streakView } from './game/streak.js';
import { ISRAEL } from './game/time.js';

// The streak columns and today's real Israel date. Dates come back as text: pg would turn a DATE into a JS Date
// at local midnight and shift the day.
export const STREAK_COLUMNS = `streak_days, streak_best, streak_last_day::text AS streak_last_day,
  streak_week::text AS streak_week, streak_week_days, (now() AT TIME ZONE '${ISRAEL}')::date::text AS streak_today`;

export type StreakRow = {
  streak_days: number;
  streak_best: number;
  streak_last_day: string | null;
  streak_week: string | null;
  streak_week_days: number;
  streak_today: string;
};

function streakOf(r: StreakRow): Streak {
  return { days: r.streak_days, best: r.streak_best, lastDay: r.streak_last_day, weekStart: r.streak_week, weekDays: r.streak_week_days };
}

// Inside the caller's transaction, with the player's users row already locked (FOR NO KEY UPDATE, as the check-in
// takes it): counts today when it isn't counted yet, so two requests at the same moment count a day once. `row` is
// what the locked SELECT read with STREAK_COLUMNS. Returns the streak as it now stands. At most one write per
// player per real day.
export async function countToday(client: PoolClient, uid: string, row: StreakRow): Promise<Streak> {
  const now = streakOf(row);
  const next = countDay(now, row.streak_today);
  if (!next) return now;
  await client.query(
    `UPDATE users SET streak_days = $2, streak_best = $3, streak_last_day = $4, streak_week = $5, streak_week_days = $6
     WHERE uid = $1`,
    [uid, next.days, next.best, next.lastDay, next.weekStart, next.weekDays],
  );
  return next;
}

// For GET /me/dashboard: what the streak card shows. Opening the dashboard is being in the app, and the app sends
// its check-in at the same moment, so the dashboard's read could come first and show today as not counted yet.
// So it counts today itself when it isn't counted yet, the same way the check-in does. Most reads find today
// already counted and write nothing. A failed count must not take the screen down: it is logged, and the
// streak is shown as read (the next check-in counts the day anyway).
// The caller has already found the player's portfolio, so the users row exists (portfolios.uid references it).
export async function loadStreak(db: Pool, uid: string): Promise<StreakView> {
  const { rows } = await db.query<StreakRow>(`SELECT ${STREAK_COLUMNS} FROM users WHERE uid = $1`, [uid]);
  if (rows.length === 0) throw new Error(`no users row for ${uid}`);
  const row = rows[0];
  if (countDay(streakOf(row), row.streak_today)) {
    try {
      const counted = await countTodayAlone(db, uid);
      if (counted) return streakView(counted.streak, counted.today);
    } catch (err) {
      console.error(`streak count on read failed for ${uid}`, err);
    }
  }
  return streakView(streakOf(row), row.streak_today);
}

// countToday in a transaction of its own (the dashboard has none). null = the row is gone.
async function countTodayAlone(db: Pool, uid: string): Promise<{ streak: Streak; today: string } | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<StreakRow>(`SELECT ${STREAK_COLUMNS} FROM users WHERE uid = $1 FOR NO KEY UPDATE`, [uid]);
    const streak = rows.length > 0 ? await countToday(client, uid, rows[0]) : null;
    await client.query('COMMIT');
    return streak && { streak, today: rows[0].streak_today };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
