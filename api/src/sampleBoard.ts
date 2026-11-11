// A SAMPLE leaderboard for development (D-033): a full board on a local database with few players and no trades.
// It was written before the scoring mechanism existed. Pure functions: no database, no framework. The script that
// uses them is api/scripts/seed-sample-board.ts (`npm run seed:sample-board`).
//
// THIS IS SAMPLE DATA, NOT THE SCORING MECHANISM. The numbers are a seeded random walk, not anyone's portfolio.
// The real places are written by the runner's scoring step (scoreEvent in scoring.ts, D-034) from the running
// totals (D-024), into the same two tables (`standings`, `weekly_scores`, D-032). Nothing in the API imports this file.

import { addDays, mondayOf } from './game/time.js';

// ---------- the sample players ----------

export const SAMPLE_PLAYERS = 40;

// 'sample-01' .. 'sample-40'. Firebase uids are 28 letters and digits, so a real player never looks like this.
export const SAMPLE_UIDS: readonly string[] = Array.from(
  { length: SAMPLE_PLAYERS },
  (_, i) => `sample-${String(i + 1).padStart(2, '0')}`,
);

// users.email is NOT NULL. `.invalid` is a reserved domain (RFC 2606): no mail can ever go there.
export function sampleEmail(uid: string): string {
  return `${uid}@sample.invalid`;
}

// Long before the game, so the admin page's sign-ups and day-1 / day-7 cohorts (D-027) never count the samples.
export const SAMPLE_CREATED_AT = '2000-01-01T00:00:00Z';

// Made-up names, one per sample uid. null = no name, shown as "שחקן" like a real player without one (D-010).
// One Latin name, so the screen is also seen with left-to-right text in a right-to-left row.
export const SAMPLE_NAMES: readonly (string | null)[] = [
  'נועה לוי', 'איתי כהן', 'מאיה פרץ', 'יונתן אברהם', 'תמר מזרחי', null, 'עומר ביטון', 'שירה דהן',
  'אורי פרידמן', 'ליה שלום', 'דניאל אזולאי', 'רוני גולן', null, 'אביגיל חדד', 'גיל רוזן', 'הדר אוחיון',
  'נדב קפלן', 'יעל בן דוד', 'אלון שפירא', null, 'מיכל אדלר', 'עידו נחום', 'אגם וקנין', 'רועי טל',
  'ענבל סגל', 'ניר אלמוג', 'קרן יוסף', 'אסף ברק', null, 'שקד עמר', 'בן חזן', 'טליה גבאי',
  'אריאל שגיא', 'דנה לביא', 'יובל כץ', 'הילה צור', 'ארז מלכה', 'Alex Stone', 'מורן דגן', 'עמית רגב',
];

// These two never move: return 0 and drawdown 0 every day, like a player who held only cash. They always have
// the same score, so the board always shows the tie-break at work (equal everything → uid order).
const STILL: ReadonlySet<string> = new Set(['sample-39', 'sample-40']);

// ---------- safety ----------

export type Target = { host: string; database: string };
export type TargetCheck = { ok: true; target: Target } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const TEST_DATABASE = 'portfolio_test';

// May the sample board be written to this database? Only a local one, never the shared test database, never in
// production. The reason is printed when it says no. Read the way node-postgres reads the URL: a `host` in the
// query string would override the one before the path, so any such URL is refused.
export function checkTarget(env: { databaseUrl: string | undefined; nodeEnv: string | undefined }): TargetCheck {
  const no = (reason: string): TargetCheck => ({ ok: false, reason });
  if (env.nodeEnv?.trim().toLowerCase() === 'production') {
    return no('NODE_ENV is production. The sample board is for development only.');
  }
  if (!env.databaseUrl) return no('DATABASE_URL is not set.');
  let url: URL;
  try {
    url = new URL(env.databaseUrl);
  } catch {
    return no('DATABASE_URL is not a postgres:// URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return no(`DATABASE_URL must start with postgres:// (it starts with ${url.protocol}//).`);
  }
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    return no('DATABASE_URL names a host in its query string (?host=), so the host it connects to is not checked.');
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return no(`the database host is "${host || '(none)'}". Only localhost or 127.0.0.1 is allowed.`);
  }
  let database: string;
  try {
    database = decodeURI(url.pathname.slice(1));
  } catch {
    return no('the database name in DATABASE_URL is not valid.');
  }
  if (!database) return no('DATABASE_URL has no database name.');
  if (database === TEST_DATABASE) {
    return no(`${TEST_DATABASE} is the test database: npm test wipes it, and a test run in progress would see the samples.`);
  }
  return { ok: true, target: { host, database } };
}

// More real players than a development database ever has.
export const MAX_DEV_PLAYERS = 1000;

// The check on the database itself, after connecting: the host name alone can't tell a local database from a port
// forward, a cloud proxy or a pgbouncer on localhost in front of a shared one. A database with more than
// MAX_DEV_PLAYERS real players looks real, so the script refuses it unless --force. `realPlayers` = users that
// aren't samples (counted up to MAX_DEV_PLAYERS + 1). null = fine.
export function checkPlayers(realPlayers: number, force: boolean): string | null {
  if (realPlayers <= MAX_DEV_PLAYERS || force) return null;
  return (
    `the database has more than ${MAX_DEV_PLAYERS.toLocaleString('en-US')} players, so it looks like a real one ` +
    '(a port forward or a proxy to a shared database also connects through localhost). ' +
    'If it really is a development database, run again with -- --force.'
  );
}

export type Args = { clear: boolean; force: boolean };

// `--clear` removes the sample board. `--force` writes over days that hold rows the script didn't write, and into a
// database with more than MAX_DEV_PLAYERS players.
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { clear: false, force: false };
  for (const a of argv) {
    if (a === '--clear') args.clear = true;
    else if (a === '--force') args.force = true;
    else return { error: `Unknown option: ${a}` };
  }
  if (args.clear && args.force) return { error: '--force only applies when writing the board, not with --clear.' };
  return args;
}

// ---------- which days and weeks ----------

export const PAST_WEEKS = 4;

export type BoardWeekPlan = { start: string; days: string[] };   // a Monday and that week's trading days

export type BoardPlan = {
  monday: string;              // the world's current week
  weekDays: string[];          // its trading days, Mon..Fri
  days: string[];              // the ones up to today: each gets a standings day
  finalWeeks: BoardWeekPlan[]; // final boards for weekly_scores, newest first
};

// Monday to Friday of the week that starts on `monday`.
export function weekdaysOf(monday: string): string[] {
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

// What the script writes for a world whose Israel date is `today` (on Sat/Sun, the week that just ended).
// `tradingDay` says whether either market opens on a date (the calendar, D-016): a day with no open or close
// never has a standings day. `weekClosed` = no open or close is left this week, so the current week also gets
// its final board, as the scoring mechanism writes it at the week's last event.
export function planBoard(today: string, weekClosed: boolean, tradingDay: (date: string) => boolean): BoardPlan {
  const monday = mondayOf(today);
  const tradingDays = (start: string) => weekdaysOf(start).filter(tradingDay);
  const weekDays = tradingDays(monday);
  const days = weekDays.filter((d) => d <= today);
  const finalWeeks: BoardWeekPlan[] = [];
  if (weekClosed && days.length > 0) finalWeeks.push({ start: monday, days: weekDays });
  for (let k = 1; k <= PAST_WEEKS; k++) {
    const start = addDays(monday, -7 * k);
    const d = tradingDays(start);
    if (d.length > 0) finalWeeks.push({ start, days: d });
  }
  return { monday, weekDays, days, finalWeeks };
}

// ---------- the made-up numbers ----------

// mulberry32: a small seeded generator. The same seed gives the same numbers on every run and every machine.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// FNV-1a: a 32-bit seed from text.
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A player's numbers at the end of a day, in 1/10,000 of a percent: ret 23500 = +2.35%. The scale of
// standings.return_pct and max_drawdown_pct (NUMERIC(10,4)).
export type DayNumbers = { ret: number; dd: number };

const MOVES_PER_DAY = 4;   // two opens and two closes
const PCT4 = 1_000_000;    // a fraction → 1/10,000 of a percent

// One player's made-up week: a random walk of the value (1 at the week's start), four moves a day, so a dip
// inside a day can raise the drawdown even when the day ends up. The drawdown is the largest drop from the
// week's peak so far, so it never goes down during the week. Seeded by the player and the week: a re-run, or a
// run later in the same week, gives the same earlier days, and a new real player doesn't change anyone else's.
export function sampleWeek(uid: string, weekStart: string, tradingDays: number): DayNumbers[] {
  const rand = mulberry32(seedOf(`${uid}|${weekStart}`));
  const still = STILL.has(uid);
  const sigma = still ? 0 : 0.002 + rand() * 0.01;     // 0.2% to 1.2% per move
  const drift = still ? 0 : (rand() - 0.45) * 0.003;   // a slight lean up (more often) or down for the week
  let value = 1;
  let peak = 1;
  let dd = 0;
  const days: DayNumbers[] = [];
  for (let d = 0; d < tradingDays; d++) {
    for (let m = 0; m < MOVES_PER_DAY; m++) {
      const z = (rand() + rand() + rand() - 1.5) * 2;   // roughly normal: mean 0, standard deviation 1
      value = Math.max(0.05, value * (1 + drift + sigma * z));
      peak = Math.max(peak, value);
      dd = Math.max(dd, Math.round(((peak - value) / peak) * PCT4));
    }
    days.push({ ret: Math.round((value - 1) * PCT4), dd });
  }
  return days;
}

// ---------- the ranking ----------

export type Entry = { uid: string } & DayNumbers;

// The ranks and the score in hundredths (8250 = 82.50), the scale of NUMERIC(6,2). rank = the place, 1..N.
export type Ranked = Entry & { returnRank: number; stabilityRank: number; score: number; rank: number };

const HUNDRED = 10_000;   // 100.00 in hundredths

// The list order (D-032): higher score first; equal scores by higher return (% gain), then smaller drawdown
// (stability), then uid, so no two players share a place. The real rule ends with the earlier sign-up instead
// of uid; every sample has the same sign-up time, so uid stands in for it. Nothing here uses a ₪ amount.
export function byPlace(a: Entry & { score: number }, b: Entry & { score: number }): number {
  return b.score - a.score || b.ret - a.ret || a.dd - b.dd || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
}

// For each value, how many come before it in `sorted`: the index of its first copy.
function countBefore(sorted: readonly number[]): Map<number, number> {
  const first = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!first.has(v)) first.set(v, i);
  });
  return first;
}

// One day's board. Percentile ranks as Postgres percent_rank() gives them, × 100:
//   return rank    = 100 × (players with a lower return) ÷ (players − 1)       100 = the best return
//   stability rank = 100 × (players with a bigger drawdown) ÷ (players − 1)    100 = the smallest drawdown
// Equal values share a rank; a lone player gets 100. Each is rounded to 2 decimals (what the table stores), and
// score = 0.85 × return rank + 0.15 × stability rank of those stored ranks, rounded to 2 decimals (half up).
// The real scoring (D-034) gives tied players the higher percentile and ranks only active players; this sample
// doesn't have to match, it only has to look right on the screen.
export function rankDay(entries: readonly Entry[]): Ranked[] {
  const n = entries.length;
  const lower = countBefore(entries.map((e) => e.ret).sort((a, b) => a - b));
  const bigger = countBefore(entries.map((e) => e.dd).sort((a, b) => b - a));
  const pct = (before: number) => (n === 1 ? HUNDRED : Math.round((before * HUNDRED) / (n - 1)));
  return entries
    .map((e) => {
      const returnRank = pct(lower.get(e.ret)!);
      const stabilityRank = pct(bigger.get(e.dd)!);
      return { ...e, returnRank, stabilityRank, score: Math.round((85 * returnRank + 15 * stabilityRank) / 100) };
    })
    .sort(byPlace)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Every trading day's board of one week, for these players: boards[i] is weekDays[i]'s.
export function sampleWeekBoards(uids: readonly string[], weekStart: string, tradingDays: number): Ranked[][] {
  const walks = uids.map((uid) => sampleWeek(uid, weekStart, tradingDays));
  return Array.from({ length: tradingDays }, (_, d) => rankDay(uids.map((uid, p) => ({ uid, ...walks[p][d] }))));
}
