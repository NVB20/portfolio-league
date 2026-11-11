// Usage monitoring (D-036): what the app reports with its check-in, and how it is stored.
// POST /me/seen (D-026) may carry a UsageReport: time and views per page, and the trade screen's confirm popup,
// since the app's previous check-in. The server checks and caps it here, then adds it to one row per player per
// page per real Israel day. Real time, like presence: the world clock plays no part.
//
// The app reports its own numbers, so the caps below bound what one request can add. They are for the admin
// page only, never for scores or money.

import type { Pool } from 'pg';
import type { UsagePage, UsageReport } from './contract.js';
import { ISRAEL } from './game/time.js';

// The player pages that are tracked. Admin pages and the login page never are (an admin clicking around would
// skew a small player base). Kept here, not in a DB CHECK, so a new page needs no migration. The app keeps the
// same list.
export const USAGE_PAGES: readonly UsagePage[] = ['dashboard', 'trade', 'journal', 'leaderboard'];

// The app checks in every 60 s, so 2 minutes of time per request leaves room for a late check-in and nothing
// more. A report over it is scaled down, page by page, to fit.
export const MAX_REPORT_MS = 120_000;
// Views, popups opened and popups backed out of: no one opens 50 pages in a minute.
export const MAX_REPORT_COUNT = 50;

type Parsed = { ok: true; report: UsageReport } | { ok: false; error: string };

// Only the object's own fields, never one inherited through its prototype. JSON.parse makes "__proto__" an
// ordinary own key, and the unknown keys are never read anyway: only the names below are looked up.
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// A count or a time as the app sent it. It must be a finite number (JSON can only send a non-finite one as an
// overflow like 1e999, which no working app does). Below 0 counts as 0, fractions are cut, and the top is capped.
function amount(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.floor(Math.min(Math.max(v, 0), max));
}

// The body of POST /me/seen, already parsed from JSON. Absent (undefined or null) = an empty report: a plain
// check-in, as older app versions send. Anything present must be shaped like UsageReport, or the whole request
// is refused and nothing is written. Unknown pages and unknown top-level fields are dropped, so a newer app
// can't break an older server. The report that comes back holds only what is worth writing: pages with a view
// or some time, and confirms only when one of its counts is above 0.
export function parseUsage(body: unknown): Parsed {
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (body === undefined || body === null) return { ok: true, report: {} };
  if (!isObject(body)) return fail('the body must be a JSON object');

  const report: UsageReport = {};

  const pages = own(body, 'pages');
  if (pages !== undefined && pages !== null) {
    if (!isObject(pages)) return fail('pages must be an object of page names');
    const raw: { page: UsagePage; views: number; ms: number }[] = [];
    for (const page of USAGE_PAGES) {
      const entry = own(pages, page);
      if (entry === undefined || entry === null) continue;
      if (!isObject(entry)) return fail(`pages.${page} must be { views, ms }`);
      const views = amount(own(entry, 'views'), MAX_REPORT_COUNT);
      if (views === null) return fail(`pages.${page}.views must be a number`);
      // Each page alone is capped first, so the total below can't overflow to Infinity.
      const ms = amount(own(entry, 'ms'), MAX_REPORT_MS);
      if (ms === null) return fail(`pages.${page}.ms must be a number`);
      raw.push({ page, views, ms });
    }
    // More time than one request may carry: shrink every page by the same factor, so the split between pages
    // stays what the app saw. Rounding down keeps the total at or under the cap.
    const totalMs = raw.reduce((sum, p) => sum + p.ms, 0);
    const scale = totalMs > MAX_REPORT_MS ? MAX_REPORT_MS / totalMs : 1;
    const kept: NonNullable<UsageReport['pages']> = {};
    for (const p of raw) {
      const ms = Math.floor(p.ms * scale);
      if (p.views > 0 || ms > 0) kept[p.page] = { views: p.views, ms };
    }
    if (Object.keys(kept).length > 0) report.pages = kept;
  }

  const confirms = own(body, 'confirms');
  if (confirms !== undefined && confirms !== null) {
    if (!isObject(confirms)) return fail('confirms must be { opened, backed }');
    const opened = amount(own(confirms, 'opened'), MAX_REPORT_COUNT);
    if (opened === null) return fail('confirms.opened must be a number');
    const backed = amount(own(confirms, 'backed'), MAX_REPORT_COUNT);
    if (backed === null) return fail('confirms.backed must be a number');
    // No "backed ≤ opened" check: a popup opened just before one check-in can be backed out of after it.
    if (opened > 0 || backed > 0) report.confirms = { opened, backed };
  }

  return { ok: true, report };
}

// The raw body text of POST /me/seen. An empty body is a plain check-in; text that isn't JSON is refused, like
// a body of the wrong shape.
export function parseUsageText(text: string): Parsed {
  if (text.trim() === '') return parseUsage(undefined);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the body must be JSON' };
  }
  return parseUsage(body);
}

// Whether a parsed report has anything to write.
export function hasUsage(report: UsageReport): boolean {
  return Object.keys(report.pages ?? {}).length > 0 || report.confirms !== undefined;
}

// Adds a parsed report to today's rows (real Israel date, computed by Postgres, so it agrees with the admin
// page's "today"). Both tables in one statement: the pages upsert runs as a WITH part of the popup upsert, so the
// report is written whole or not at all, and both parts share one now(), so a report sent at midnight can't split
// across two days. A failed check-in therefore wrote no usage, and the app can safely send its report again.
// A part with nothing to add inserts no rows (empty arrays; counts of 0 fail the WHERE).
// Not in a transaction with the check-in (D-026): the users row lock is held only for the presence write, never
// for this. The statement is atomic, so two check-ins at the same moment both add up. It is always the same
// statement, with the pages in the same order (USAGE_PAGES), so two of them lock rows in the same order and can't
// deadlock each other.
export async function recordUsage(db: Pool, uid: string, report: UsageReport): Promise<void> {
  const rows = USAGE_PAGES.flatMap((page) => {
    const p = report.pages?.[page];
    return p && (p.views > 0 || p.ms > 0) ? [{ page, views: p.views, ms: p.ms }] : [];
  });
  const c = report.confirms ?? { opened: 0, backed: 0 };
  await db.query(
    `WITH pages AS (
       INSERT INTO usage_pages_daily AS t (day, page, uid, views, ms)
       SELECT (now() AT TIME ZONE '${ISRAEL}')::date, r.page, $1::text, r.views, r.ms
       FROM unnest($2::text[], $3::int[], $4::bigint[]) AS r (page, views, ms)
       ON CONFLICT (day, page, uid) DO UPDATE SET views = t.views + EXCLUDED.views, ms = t.ms + EXCLUDED.ms
     )
     INSERT INTO usage_confirms_daily AS t (day, uid, opened, backed)
     SELECT (now() AT TIME ZONE '${ISRAEL}')::date, $1::text, $5::int, $6::int
     WHERE $5::int > 0 OR $6::int > 0
     ON CONFLICT (day, uid) DO UPDATE SET opened = t.opened + EXCLUDED.opened, backed = t.backed + EXCLUDED.backed`,
    [uid, rows.map((r) => r.page), rows.map((r) => r.views), rows.map((r) => r.ms), c.opened, c.backed],
  );
}
