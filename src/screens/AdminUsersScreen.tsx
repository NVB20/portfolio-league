// The users page (/admin-users, D-044): every user with their email, visits ("כניסות") and role, 50 a page, and the
// admin role given or taken away. Reached from the "משתמשים" admin tab; only admins can open it (_layout.tsx), and
// the API checks the role again on every request.
//
// Same look as the other admin pages: the headline above one full-width card (the leaderboard's TableSection), a
// table that scrolls sideways on narrow screens (as the dashboard's players table), and the trade screen's confirm
// popup before a role change. Your own row has no role button: the API refuses to take your own role (SELF_DEMOTE).

import { useState } from 'react';
import { ActivityIndicator, Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AdminUser, AdminUsersSort } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { useAdminUsers, useRoleChange } from '../admin/useAdminUsers';
import { count, instantDateHe, lastSeenLabel } from '../admin/copy';
import { pageCount, rangeText, resultsLine, roleButtonLabel, roleChange, SELF_NOTE, SORT_OPTIONS } from '../admin/users';
import { AdminFooter } from '../components/admin/AdminBits';
import { Button } from '../components/dashboard/Button';
import { Card, Empty } from '../components/dashboard/Card';
import { Chip } from '../components/dashboard/Chip';
import { MAX_WIDTH, ltr, rtl } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useReduce, useScrollMotion } from '../components/dashboard/motion';
import { Accent } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { Segmented } from '../components/leaderboard/Segmented';
import { TableSection } from '../components/leaderboard/TableSection';

type Who = 'all' | 'admins';
const WHO: { value: Who; label: string }[] = [
  { value: 'all', label: 'כולם' },
  { value: 'admins', label: 'מנהלים בלבד' },
];

export default function AdminUsersScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);
  const name = user?.displayName || user?.email?.split('@')[0] || 'מנהל';

  const [q, setQ] = useState('');
  const [sort, setSort] = useState<AdminUsersSort>('joined');
  const [who, setWho] = useState<Who>('all');
  const [page, setPage] = useState(1);
  const list = useAdminUsers({ q, sort, adminsOnly: who === 'admins', page });
  const role = useRoleChange(list.replace);
  const [asking, setAsking] = useState<AdminUser | null>(null);   // the user the confirm popup is about

  // A new search, order or filter starts again on page 1.
  const onQuery = (v: string) => {
    setQ(v);
    setPage(1);
  };
  const onSort = (v: AdminUsersSort) => {
    setSort(v);
    setPage(1);
  };
  const onWho = (v: Who) => {
    setWho(v);
    setPage(1);
  };

  const ask = (u: AdminUser) => {
    role.clearError();
    setAsking(u);
  };
  const confirm = async () => {
    if (!asking) return;
    if (await role.change(asking.uid, !asking.isAdmin)) setAsking(null);
  };

  const total = list.data?.total ?? null;
  const filtered = q.trim() !== '' || who === 'admins';

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <TableSection
                first
                eyebrow="משתמשים · צד הניהול"
                title={
                  total === null ? (
                    'כל המשתמשים.'
                  ) : (
                    <>
                      <Accent>{count(total)}</Accent>
                      {` ${total === 1 ? 'משתמש' : 'משתמשים'}\n${filtered ? 'מתאימים.' : 'בליגה.'}`}
                    </>
                  )
                }
                body="כניסות: כמה פעמים פתחו את האפליקציה אחרי חצי שעה בלעדיה, מאז שנרשמו. כל מתן או הסרה של הרשאת ניהול נרשמים ביומן פעולות הניהול."
                toolbar={<Segmented options={WHO} value={who} onChange={onWho} label="אילו משתמשים להציג" />}
              >
                <UsersCard
                  me={user?.uid ?? null}
                  q={q}
                  onQuery={onQuery}
                  sort={sort}
                  onSort={onSort}
                  filtered={filtered}
                  list={list}
                  page={page}
                  onPage={setPage}
                  onRole={ask}
                />
              </TableSection>
            </OffsetProvider>
            <AdminFooter>
              צד הניהול · רק מנהלים רואים את העמוד הזה, וכל בקשה נבדקת שוב בשרת. מנהל לא יכול להסיר את ההרשאה של עצמו, ולכן תמיד נשאר מנהל אחד לפחות.
            </AdminFooter>
          </View>
        </Animated.ScrollView>

        <TopBar clock={null} name={name} rankLine="מנהל" side="admin" adminTab="admin-users" />

        <ConfirmRole user={asking} busy={role.busy} error={role.error} onBack={() => setAsking(null)} onConfirm={confirm} />
      </View>
    </MotionProvider>
  );
}

type List = ReturnType<typeof useAdminUsers>;

function UsersCard({ me, q, onQuery, sort, onSort, filtered, list, page, onPage, onRole }: {
  me: string | null;
  q: string;
  onQuery: (q: string) => void;
  sort: AdminUsersSort;
  onSort: (s: AdminUsersSort) => void;
  filtered: boolean;
  list: List;
  page: number;
  onPage: (p: number) => void;
  onRole: (u: AdminUser) => void;
}) {
  const { colors } = useTheme();
  const { data, error, isLoading, reload } = list;
  const users = data?.users ?? [];
  const pages = data ? pageCount(data.total, data.pageSize) : 1;

  return (
    <Card
      title="כל המשתמשים"
      sub={data ? resultsLine(data.total, filtered) : 'טוען…'}
      end={isLoading && data ? <ActivityIndicator color={colors.accent} /> : data ? <Chip>{rangeText(data.page, data.pageSize, users.length, data.total)}</Chip> : null}
    >
      <TextInput
        value={q}
        onChangeText={onQuery}
        placeholder="חיפוש: שם או אימייל"
        placeholderTextColor={colors.faint}
        accessibilityLabel="חיפוש משתמש"
        maxLength={100}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.search, { backgroundColor: colors.surface2, borderColor: colors.line2, color: colors.fg }]}
      />
      <View style={styles.sortRow}>
        <Text style={[styles.sortLabel, { color: colors.faint }]}>מיון:</Text>
        <Segmented options={SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))} value={sort} onChange={onSort} label="סדר הטבלה" />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Empty>{error}</Empty>
          <Button label="נסו שוב" small onPress={reload} />
        </View>
      ) : isLoading && !data ? (
        <ActivityIndicator style={styles.spinner} color={colors.accent} />
      ) : users.length === 0 ? (
        <Empty>{filtered ? 'אף משתמש לא מתאים לחיפוש.' : 'עוד אין משתמשים.'}</Empty>
      ) : (
        // The table keeps its width on phones and scrolls sideways inside the card.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll} contentContainerStyle={styles.tableContent}>
          <View style={[styles.table, isLoading && styles.stale]}>
            <UserHeader />
            {users.map((u) => (
              <UserRow key={u.uid} user={u} self={u.uid === me} now={list.loadedAt} onRole={onRole} />
            ))}
          </View>
        </ScrollView>
      )}

      {data && pages > 1 ? (
        <View style={styles.pager}>
          <Button label="הקודם" small disabled={page <= 1 || isLoading} onPress={() => onPage(page - 1)} />
          <Text style={[styles.pagerText, styles.num, { color: colors.muted }]}>{`עמוד ${count(page)} מתוך ${count(pages)}`}</Text>
          <Button label="הבא" small disabled={page >= pages || isLoading} onPress={() => onPage(page + 1)} />
        </View>
      ) : null}
    </Card>
  );
}

// Fixed columns + the user column's minimum + the gaps = the table's minimum width (styles.table).
const COLS = { role: 64, visits: 64, seen: 100, joined: 88, action: 120 };

function UserHeader() {
  const { colors } = useTheme();
  const cell = [styles.th, { color: colors.faint }];
  return (
    <View style={[styles.tr, { borderBottomColor: colors.line }]}>
      <Text style={[cell, styles.userCol]}>משתמש</Text>
      <Text style={[cell, { width: COLS.role }]}>תפקיד</Text>
      <Text style={[cell, { width: COLS.visits }]}>כניסות</Text>
      <Text style={[cell, { width: COLS.seen }]}>נראה לאחרונה</Text>
      <Text style={[cell, { width: COLS.joined }]}>הצטרף</Text>
      <Text style={[cell, { width: COLS.action }]}>הרשאת ניהול</Text>
    </View>
  );
}

// `now`: when the page's data arrived, so "last seen" reads the same as the moment the API answered.
function UserRow({ user: u, self, now, onRole }: { user: AdminUser; self: boolean; now: number; onRole: (u: AdminUser) => void }) {
  const { colors } = useTheme();
  const seen = lastSeenLabel(u.lastSeenAt, now);
  const online = seen === 'מחובר';
  return (
    <View style={[styles.tr, { borderBottomColor: colors.line }]}>
      <View style={styles.userCol}>
        <Text style={[styles.td, styles.name, { color: colors.fg }]} numberOfLines={1}>{u.name ?? 'ללא שם תצוגה'}</Text>
        <Text style={[styles.email, ltr, { color: colors.faint }]} numberOfLines={1}>{u.email}</Text>
      </View>
      <View style={{ width: COLS.role }}>
        <Chip variant={u.isAdmin ? 'up' : 'ghost'}>{u.isAdmin ? 'מנהל' : 'שחקן'}</Chip>
      </View>
      <Text style={[styles.td, styles.num, { width: COLS.visits, color: colors.fg }]}>{count(u.visits)}</Text>
      <View style={[styles.seenCell, { width: COLS.seen }]}>
        {online ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
        <Text style={[styles.td, { color: online ? colors.accent : colors.muted }]} numberOfLines={1}>{seen}</Text>
      </View>
      <Text style={[styles.td, styles.num, { width: COLS.joined, color: colors.muted }]}>{instantDateHe(u.joinedAt)}</Text>
      <View style={{ width: COLS.action }}>
        {self ? (
          <Text style={[styles.selfNote, { color: colors.faint }]}>{SELF_NOTE}</Text>
        ) : (
          <Button
            label={roleButtonLabel(u)}
            small
            variant={u.isAdmin ? 'outline' : 'primary'}
            hint={`${roleButtonLabel(u)}: ${u.email}`}
            onPress={() => onRole(u)}
          />
        )}
      </View>
    </View>
  );
}

// The confirm step before a role change, as a popup over the page (the trade screen's ConfirmOrder look). It stays
// open while the API answers, and shows the API's reason when it refuses.
function ConfirmRole({ user, busy, error, onBack, onConfirm }: {
  user: AdminUser | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { colors } = useTheme();
  const reduce = useReduce();
  const c = user ? roleChange(user) : null;
  const back = busy ? () => {} : onBack;
  return (
    <Modal visible={user !== null} transparent animationType={reduce ? 'none' : 'fade'} onRequestClose={back}>
      {/* The Modal renders outside the screen's tree, so the Hebrew direction is set again here. */}
      <Pressable style={[styles.scrim, rtl]} onPress={back} accessibilityLabel="סגירה בלי לשנות">
        {/* Inner Pressable swallows taps so tapping inside the popup doesn't close it. */}
        {user && c ? (
          <Pressable
            onPress={() => {}}
            role="dialog"
            aria-modal
            aria-label={c.title}
            style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.line2 }, dialogShadow]}
          >
            <View>
              <Text style={[styles.dTitle, { color: colors.fg }]}>{c.title}</Text>
              <Text style={[styles.dSub, ltr, { color: colors.faint }]} numberOfLines={1}>{user.email}</Text>
            </View>
            <Text style={[styles.dBody, { color: colors.muted }]}>{c.body}</Text>
            {c.note ? <Text style={[styles.dNote, { color: colors.warn }]}>{c.note}</Text> : null}
            {error ? <Text accessibilityRole="alert" style={[styles.dNote, { color: colors.neg }]}>{error}</Text> : null}
            <View style={styles.pair}>
              <View style={styles.flex}>
                <Button label={busy ? 'שומר…' : c.confirm} variant="primary" disabled={busy} onPress={onConfirm} />
              </View>
              <View style={styles.flex}>
                <Button label="חזור" disabled={busy} onPress={onBack} />
              </View>
            </View>
          </Pressable>
        ) : null}
      </Pressable>
    </Modal>
  );
}

// CSS shadow for the popup on web, as the trade screen's.
const dialogShadow = { boxShadow: '0 30px 60px -20px rgba(0,0,0,.8)' } as unknown as object;

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 64 },
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  num: { fontVariant: ['tabular-nums'] },
  search: { marginTop: 14, borderWidth: 1, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, fontSize: 13, textAlign: 'right', minHeight: 44 },
  sortRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  sortLabel: { fontSize: 12.5 },
  spinner: { marginTop: 20 },
  errorBox: { alignItems: 'flex-start', gap: 10 },
  tableScroll: { marginTop: 12 },
  tableContent: { flexGrow: 1 },
  table: { flexGrow: 1, minWidth: 676 },   // 436 of COLS + 200 for the user + 5 gaps of 8
  stale: { opacity: 0.6 },                 // the last page stays on screen, dimmed, while the next one loads
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: 1 },
  // textAlign right on every cell: a number or an email has no Hebrew letter, so the browser would set it
  // left-to-right and push it to the left of its column, away from its Hebrew header.
  th: { fontSize: 12, fontWeight: '500', textAlign: 'right' },
  td: { fontSize: 13.5, textAlign: 'right' },
  userCol: { flex: 1, minWidth: 200 },
  name: { flexShrink: 1 },
  email: { fontSize: 11.5, marginTop: 1, textAlign: 'right' },
  seenCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  selfNote: { fontSize: 12, textAlign: 'right' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 16 },
  pagerText: { fontSize: 13 },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: 'rgba(4, 10, 12, 0.6)' },
  dialog: { width: '100%', maxWidth: 400, borderWidth: 1, borderRadius: 22, padding: 20, gap: 14 },
  dTitle: { fontSize: 18, fontWeight: '600' },
  dSub: { fontSize: 12.5, marginTop: 2, textAlign: 'right' },
  dBody: { fontSize: 14, lineHeight: 21 },
  dNote: { fontSize: 12.5, lineHeight: 18 },
  pair: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
