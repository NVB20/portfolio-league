// The users page's pure helpers (src/admin/users.ts, D-044) and the action log's words for a role change
// (src/admin/copy.ts). No database, no React. Loaded at run time, not imported, for the reason written at the top of
// app-dashboard.test.ts: to this package's type check every file under src/ is CommonJS.

import { describe, expect, it } from 'vitest';
import type { AdminActionView, AdminUser, AdminUsersSort } from '../src/contract.js';

const app = <T>(path: string): Promise<T> => import(new URL(`../../src/${path}.ts`, import.meta.url).href) as Promise<T>;

type RoleChange = { admin: boolean; title: string; body: string; note: string | null; confirm: string };

const { pageCount, rangeText, resultsLine, roleButtonLabel, roleChange, SORT_OPTIONS } = await app<{
  pageCount(total: number, pageSize: number): number;
  rangeText(page: number, pageSize: number, shown: number, total: number): string;
  resultsLine(total: number, filtered: boolean): string;
  roleButtonLabel(user: Pick<AdminUser, 'isAdmin'>): string;
  roleChange(user: Pick<AdminUser, 'email' | 'isAdmin'>): RoleChange;
  SORT_OPTIONS: { key: AdminUsersSort; label: string }[];
}>('admin/users');

const { actionLabel } = await app<{ actionLabel(a: AdminActionView): string }>('admin/copy');

describe('users page helpers (D-044)', () => {
  it('offers the three orders the API knows, newest first by default', () => {
    expect(SORT_OPTIONS.map((o) => o.key)).toEqual(['joined', 'visits', 'lastSeen']);
  });

  it('counts pages, at least one', () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(1284, 50)).toBe(26);
  });

  it('says which rows are on screen', () => {
    expect(rangeText(1, 50, 50, 1284)).toBe('1–50 מתוך 1,284');
    expect(rangeText(26, 50, 34, 1284)).toBe('1,251–1,284 מתוך 1,284');
    expect(rangeText(1, 50, 0, 0)).toBe('אין משתמשים');
    expect(rangeText(30, 50, 0, 1284)).toBe('אין משתמשים בעמוד 30');
  });

  it('says how many are registered, or how many the search found', () => {
    expect(resultsLine(1284, false)).toBe('1,284 משתמשים רשומים');
    expect(resultsLine(1, true)).toBe('משתמש אחד מתאים');
    expect(resultsLine(0, true)).toBe('0 משתמשים מתאימים');
  });

  it('asks before giving the role, and names the account', () => {
    const c = roleChange({ email: 'ann@example.com', isAdmin: false });
    expect(c).toMatchObject({ admin: true, confirm: 'הפוך למנהל', note: null });
    expect(c.body).toContain('ann@example.com');
    expect(roleButtonLabel({ isAdmin: false })).toBe('הפוך למנהל');
  });

  it('asks before taking it away, and says the demo password still lets anyone back (D-043)', () => {
    const c = roleChange({ email: 'ann@example.com', isAdmin: true });
    expect(c).toMatchObject({ admin: false, confirm: 'הסר הרשאת ניהול' });
    expect(c.note).toContain('123456');
    expect(roleButtonLabel({ isAdmin: true })).toBe('הסר ניהול');
  });
});

describe('the action log names the account a role change touched', () => {
  const log = (action: AdminActionView['action'], detail: Record<string, unknown>): AdminActionView => ({
    at: '2026-11-12T10:00:00Z', admin: 'Root', action, worldFrom: null, worldTo: null, detail,
  });

  it('for a grant and a revoke', () => {
    expect(actionLabel(log('role_grant', { target: 'ann', email: 'ann@example.com' }))).toBe('נתן הרשאת ניהול ל־ann@example.com');
    expect(actionLabel(log('role_revoke', { target: 'ann', email: 'ann@example.com' }))).toBe('הסיר את הרשאת הניהול של ann@example.com');
  });

  it('and still words the clock moves as before', () => {
    expect(actionLabel(log('clock_to_open', { ordersExecuted: 5 }))).toBe('קידם לפתיחה הבאה · 5 פקודות בוצעו');
  });
});
