// Words and numbers for the users page (/admin-users, D-044). Pure functions, no React, no network: the users, their
// visits and their roles come from GET /admin/users, and only the API changes a role.

import type { AdminUser, AdminUsersSort } from '../../api/src/contract';
import { count } from './copy';

// The three orders, as the API names them. Each is one way: the order an admin looks for first.
export const SORT_OPTIONS: { key: AdminUsersSort; label: string }[] = [
  { key: 'joined', label: 'הצטרפו לאחרונה' },
  { key: 'visits', label: 'הכי הרבה כניסות' },
  { key: 'lastSeen', label: 'נראו לאחרונה' },
];

// How many pages `total` users fill; at least 1, so an empty result still reads "page 1 of 1".
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// "1–50 מתוך 1,284" for the rows on screen. Nobody matches: "אין משתמשים".
export function rangeText(page: number, pageSize: number, shown: number, total: number): string {
  if (shown === 0) return total === 0 ? 'אין משתמשים' : `אין משתמשים בעמוד ${count(page)}`;
  const from = (page - 1) * pageSize + 1;
  return `${count(from)}–${count(from + shown - 1)} מתוך ${count(total)}`;
}

// "1,284 משתמשים" / "משתמש אחד"
export function usersText(n: number): string {
  return n === 1 ? 'משתמש אחד' : `${count(n)} משתמשים`;
}

// The headline under the page title: everyone, or how many the search or the filter found.
export function resultsLine(total: number, filtered: boolean): string {
  if (total === 1) return filtered ? 'משתמש אחד מתאים' : 'משתמש אחד רשום';
  return filtered ? `${usersText(total)} מתאימים` : `${usersText(total)} רשומים`;
}

export type RoleChange = { admin: boolean; title: string; body: string; note: string | null; confirm: string };

// The confirm popup for a role change. Taking the role away also says that the demo password (D-043) lets any
// player make themselves an admin again, so an admin doesn't think the change locks anyone out.
export function roleChange(user: Pick<AdminUser, 'email' | 'isAdmin'>): RoleChange {
  if (user.isAdmin) {
    return {
      admin: false,
      title: 'להסיר הרשאת ניהול?',
      body: `החשבון ${user.email} יחזור להיות שחקן רגיל, וכל בקשה שלו לצד הניהול תיחסם מהבקשה הבאה.`,
      note: 'סיסמת ההדגמה (123456) עדיין פתוחה לכל שחקן, כך שאפשר לחזור לצד הניהול בלי עזרה.',
      confirm: 'הסר הרשאת ניהול',
    };
  }
  return {
    admin: true,
    title: 'להפוך למנהל?',
    body: `לחשבון ${user.email} תהיה גישה לכל צד הניהול: קידום השעון, הניטור וניהול המשתמשים.`,
    note: null,
    confirm: 'הפוך למנהל',
  };
}

// The role button's label in the row. On your own admin row there is no button, only this note.
export function roleButtonLabel(user: Pick<AdminUser, 'isAdmin'>): string {
  return user.isAdmin ? 'הסר ניהול' : 'הפוך למנהל';
}
export const SELF_NOTE = 'זה החשבון שלך';
