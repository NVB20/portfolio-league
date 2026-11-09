// Every weekday (Mon to Fri) on which a market is closed, with the reason (D-016).
// Weekends are a rule in code and are not listed. Copied into `market_closures` by `npm run seed:world`,
// which also checks this list against the price data: a weekday is closed here exactly when it has no prices.
//
// Checked by hand on 09.11.2026 against the Yahoo history (2023-11-06 to 2026-11-05).

import type { Closure } from '../game/marketHours.js';

export type WorldClosure = Closure & { reasonEn: string };

const tase = (day: string, reason: string, reasonEn: string): WorldClosure => ({ market: 'TASE', day, reason, reasonEn });
const us = (day: string, reasonEn: string): WorldClosure => ({ market: 'US', day, reason: US_HE[reasonEn] ?? reasonEn, reasonEn });

const US_HE: Record<string, string> = {
  "New Year's Day": 'ראש השנה האזרחית',
  'Martin Luther King Jr. Day': 'יום מרטין לותר קינג',
  "Presidents' Day": 'יום הנשיאים',
  'Good Friday': 'יום שישי הטוב',
  'Memorial Day': 'יום הזיכרון האמריקאי',
  Juneteenth: "ג'ונטינת'",
  'Independence Day': 'יום העצמאות האמריקאי',
  'Labor Day': 'יום העבודה האמריקאי',
  Thanksgiving: 'חג ההודיה',
  Christmas: 'חג המולד',
  'National Day of Mourning (President Carter)': 'יום אבל לאומי (הנשיא קרטר)',
};

// TASE traded Sunday to Thursday until it moved to Monday to Friday in January 2026 (first Friday: 09.01.2026).
// Yahoo has no TASE Sundays, so in the game TASE trades Monday to Thursday until then (D-013).
const FRIDAYS_FROM = '2023-11-10';
const FRIDAYS_TO = '2026-01-02';

function taseFridaysBefore2026(): WorldClosure[] {
  const out: WorldClosure[] = [];
  for (let d = new Date(`${FRIDAYS_FROM}T00:00:00Z`); d <= new Date(`${FRIDAYS_TO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(tase(d.toISOString().slice(0, 10), 'הבורסה בת״א סגורה בימי שישי עד ינואר 2026', 'TASE closed on Fridays until January 2026'));
  }
  return out;
}

const TASE_HOLIDAYS: WorldClosure[] = [
  tase('2024-02-27', 'בחירות לרשויות המקומיות', 'Municipal elections'),
  tase('2024-04-22', 'ערב פסח', 'Passover eve'),
  tase('2024-04-23', 'פסח', 'Passover'),
  tase('2024-04-29', 'שביעי של פסח', 'Last day of Passover'),
  tase('2024-05-13', 'יום הזיכרון', 'Memorial Day'),
  tase('2024-05-14', 'יום העצמאות', 'Independence Day'),
  tase('2024-06-11', 'ערב שבועות', 'Shavuot eve'),
  tase('2024-06-12', 'שבועות', 'Shavuot'),
  tase('2024-08-13', 'תשעה באב', "Tisha B'Av"),
  tase('2024-10-02', 'ערב ראש השנה', 'Rosh Hashanah eve'),
  tase('2024-10-03', 'ראש השנה', 'Rosh Hashanah'),
  tase('2024-10-16', 'ערב סוכות', 'Sukkot eve'),
  tase('2024-10-17', 'סוכות', 'Sukkot'),
  tase('2024-10-23', 'ערב שמחת תורה', 'Simchat Torah eve'),
  tase('2024-10-24', 'שמחת תורה', 'Simchat Torah'),
  tase('2025-04-30', 'יום הזיכרון', 'Memorial Day'),
  tase('2025-05-01', 'יום העצמאות', 'Independence Day'),
  tase('2025-06-02', 'שבועות', 'Shavuot'),
  tase('2025-09-22', 'ערב ראש השנה', 'Rosh Hashanah eve'),
  tase('2025-09-23', 'ראש השנה', 'Rosh Hashanah'),
  tase('2025-09-24', 'ראש השנה', 'Rosh Hashanah'),
  tase('2025-10-01', 'ערב יום כיפור', 'Yom Kippur eve'),
  tase('2025-10-02', 'יום כיפור', 'Yom Kippur'),
  tase('2025-10-06', 'ערב סוכות', 'Sukkot eve'),
  tase('2025-10-07', 'סוכות', 'Sukkot'),
  tase('2025-10-13', 'ערב שמחת תורה', 'Simchat Torah eve'),
  tase('2025-10-14', 'שמחת תורה', 'Simchat Torah'),
  tase('2026-03-03', 'פורים', 'Purim'),
  tase('2026-04-01', 'ערב פסח', 'Passover eve'),
  tase('2026-04-02', 'פסח', 'Passover'),
  tase('2026-04-07', 'ערב שביעי של פסח', 'Last day of Passover eve'),
  tase('2026-04-08', 'שביעי של פסח', 'Last day of Passover'),
  tase('2026-04-21', 'יום הזיכרון', 'Memorial Day'),
  tase('2026-04-22', 'יום העצמאות', 'Independence Day'),
  tase('2026-05-21', 'ערב שבועות', 'Shavuot eve'),
  tase('2026-05-22', 'שבועות', 'Shavuot'),
  tase('2026-07-23', 'תשעה באב', "Tisha B'Av"),
  tase('2026-09-11', 'ערב ראש השנה', 'Rosh Hashanah eve'),
  // Between Rosh Hashanah and Yom Kippur. No known holiday; Yahoo simply has no TASE prices for it.
  tase('2026-09-18', 'אין נתוני מסחר', 'No trading data'),
  tase('2026-09-21', 'יום כיפור', 'Yom Kippur'),
  tase('2026-09-25', 'ערב סוכות', 'Sukkot eve'),
  tase('2026-10-02', 'ערב שמחת תורה', 'Simchat Torah eve'),
  tase('2026-10-27', 'בחירות לכנסת', 'Knesset elections'),
];

const US_HOLIDAYS: WorldClosure[] = [
  us('2023-11-23', 'Thanksgiving'),
  us('2023-12-25', 'Christmas'),
  us('2024-01-01', "New Year's Day"),
  us('2024-01-15', 'Martin Luther King Jr. Day'),
  us('2024-02-19', "Presidents' Day"),
  us('2024-03-29', 'Good Friday'),
  us('2024-05-27', 'Memorial Day'),
  us('2024-06-19', 'Juneteenth'),
  us('2024-07-04', 'Independence Day'),
  us('2024-09-02', 'Labor Day'),
  us('2024-11-28', 'Thanksgiving'),
  us('2024-12-25', 'Christmas'),
  us('2025-01-01', "New Year's Day"),
  us('2025-01-09', 'National Day of Mourning (President Carter)'),
  us('2025-01-20', 'Martin Luther King Jr. Day'),
  us('2025-02-17', "Presidents' Day"),
  us('2025-04-18', 'Good Friday'),
  us('2025-05-26', 'Memorial Day'),
  us('2025-06-19', 'Juneteenth'),
  us('2025-07-04', 'Independence Day'),
  us('2025-09-01', 'Labor Day'),
  us('2025-11-27', 'Thanksgiving'),
  us('2025-12-25', 'Christmas'),
  us('2026-01-01', "New Year's Day"),
  us('2026-01-19', 'Martin Luther King Jr. Day'),
  us('2026-02-16', "Presidents' Day"),
  us('2026-04-03', 'Good Friday'),
  us('2026-05-25', 'Memorial Day'),
  us('2026-06-19', 'Juneteenth'),
  us('2026-07-03', 'Independence Day'),
  us('2026-09-07', 'Labor Day'),
];

export const WORLD_CLOSURES: WorldClosure[] = [...taseFridaysBefore2026(), ...TASE_HOLIDAYS, ...US_HOLIDAYS];
