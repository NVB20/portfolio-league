// The daily streak card's words and week dots (D-039), built from the API's StreakView. The API counts the days
// (real Israel dates, never the world clock); this file only says them. Pure: no React, no clock.

import type { StreakView } from '../../api/src/contract';

// Sunday to Saturday, the Hebrew weekday letters. In the RTL page Sunday sits on the right.
export const WEEK_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const;

// 'in' = was in the app that day. 'missed' = a day of this week already over with no entry. 'today' = today, not
// counted yet. 'future' = later this week.
export type DotState = 'in' | 'missed' | 'today' | 'future';
export type WeekDot = { letter: string; state: DotState; isToday: boolean };

// "יום אחד", "יומיים", "5 ימים".
export function daysText(n: number): string {
  if (n === 1) return 'יום אחד';
  if (n === 2) return 'יומיים';
  return `${n} ימים`;
}

// The big line: "5 ימים ברצף", or "עוד אין רצף".
export function streakTitle(s: StreakView): string {
  return s.days === 0 ? 'עוד אין רצף' : `${daysText(s.days)} ברצף`;
}

// The line under it: whether today is counted, and the best streak when it says something new.
export function streakLine(s: StreakView): string {
  if (!s.countedToday) return s.days > 0 ? 'היכנסו היום כדי לשמור על הרצף' : 'כניסה היום מתחילה רצף חדש';
  if (s.best > s.days) return `היום נספר · השיא שלך: ${daysText(s.best)}`;
  if (s.days > 1) return 'היום נספר · זה השיא שלך';
  return 'היום נספר · חזרו מחר כדי להמשיך';
}

// This real week, Sunday to Saturday.
export function weekDots(s: StreakView): WeekDot[] {
  return WEEK_LETTERS.map((letter, d) => {
    const isToday = d === s.weekday;
    const state: DotState = s.week[d] ? 'in' : isToday ? 'today' : d < s.weekday ? 'missed' : 'future';
    return { letter, state, isToday };
  });
}

// What a screen reader says for the dots: "ימים השבוע: 3 מתוך 4".
export function weekLabel(s: StreakView): string {
  return `ימים השבוע: ${s.week.filter(Boolean).length} מתוך ${s.weekday + 1}`;
}
