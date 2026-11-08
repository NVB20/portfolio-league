// Time-zone helpers. Pure functions: no database, no framework.
// The world clock is stored as one UTC instant; the rules speak in Israel time and New York time.

export const ISRAEL = 'Asia/Jerusalem';
export const NEW_YORK = 'America/New_York';

export type ZonedParts = {
  date: string;      // 'YYYY-MM-DD' in that zone
  weekday: number;   // 0 = Sunday ... 6 = Saturday
  minutes: number;   // minutes since local midnight, 0..1439
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// What a wall clock in `timeZone` shows at `instant`.
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, weekday: weekdayOf(date), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// The weekday of a calendar date (no time zone involved).
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

// The instant when a wall clock in `timeZone` shows `date` + `minutes`. Handles daylight saving.
export function zonedToInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, 0, minutes);
  // Guess, see how far off the zone's clock is, correct. A second pass fixes guesses that crossed a DST switch.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const shown = zonedParts(new Date(guess), timeZone);
    const [sy, sm, sd] = shown.date.split('-').map(Number);
    guess += wanted - Date.UTC(sy, sm - 1, sd, 0, shown.minutes);
  }
  return new Date(guess);
}

// ISO 8601 week number of a calendar date (weeks start Monday; week 1 holds the first Thursday).
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
}

// Monday of the week that holds `date` (the competition week runs Monday to Friday).
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// A calendar date moved by `days` (negative = back).
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
