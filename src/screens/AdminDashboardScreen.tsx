// The admin side (/admin-dashboard). Reached from "מעבר לצד הניהול" in the avatar menu; only admins can
// open it (_layout.tsx), and the API checks the role again on every request.
//
// Same look as the player dashboard (docs/design/dashboard): scrolling sections with a headline and rows of
// cards, one inverse card per section (DD-04). Design: the "Admin Dashboard Vision" artifact.
//   1. Overview: who is online now, who came today, who came back several times (D-026), sign-ups,
//      30-day trend with next-day / 7-day return
//   2. World clock: advance / start / stop (POST /admin/clock/*), both markets, the
//      engine's last run, the order queue. "קדם שעון" on the player dashboard opens the page here (?to=clock)
//   3. Players: the top 5, searchable; more than that is the leaderboard's job
//   4. System: how far the data goes, the admin action log
// Numbers we don't have yet say what will fill them, never a made-up value.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, LayoutChangeEvent, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { AdminActionView, AdminOverview, AdminPlayer, AdminRunView } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { useAdminActivity, useAdminOverview, useAdminPlayers, useClockAction } from '../admin/useAdmin';
import {
  actionLabel,
  advanceLabel,
  clockOutcomeLine,
  clockSummary,
  count,
  dateHe,
  lastSeenLabel,
  marketsLine,
  playersSummary,
  playersWord,
  rateLabel,
  realTimeLabel,
  RUN_STATUS,
  runLabel,
} from '../admin/copy';
import { dayLabel, ils } from '../dashboard/format';
import { AdminFallback, AdminFooter, BigNumber, Line, Lines, SubText, Tiles } from '../components/admin/AdminBits';
import { Button } from '../components/dashboard/Button';
import { Card, Empty, usePalette } from '../components/dashboard/Card';
import { CardRow } from '../components/dashboard/CardRow';
import { Chip } from '../components/dashboard/Chip';
import { MAX_WIDTH, ltr } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { Accent, Faint, Section, Strong } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { WorldClockCard } from '../components/dashboard/WorldClockCard';

// Advancing can't be undone (the clock never goes back), so the first press only arms the button.
const CONFIRM_MS = 4_000;
// After the trend card gets its data: time for it to lay out at its new height before the jump to the clock stops following.
const JUMP_SETTLE_MS = 300;

export default function AdminDashboardScreen() {
  const { user } = useAuth();
  const { data, error, isLoading, reload } = useAdminOverview();
  const name = user?.displayName || user?.email?.split('@')[0] || 'מנהל';

  if (data) return <AdminView data={data} name={name} reload={reload} />;

  return (
    <AdminFallback isLoading={isLoading} error={error} onRetry={reload}>
      <TopBar clock={null} name={name} rankLine="מנהל" side="admin" adminTab="admin-dashboard" />
    </AdminFallback>
  );
}

function AdminView({ data, name, reload }: { data: AdminOverview; name: string; reload: () => void }) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);
  const activity = useAdminActivity();
  const scroll = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);

  // Opened from "קדם שעון" (?to=clock): start at the world clock section. The trend card above it gets its
  // data after the page opens and grows, pushing the clock down, so the jump follows until that card is done.
  // The clock section starts where the overview ends. Read it from the overview: on web, onLayout fires only
  // when a box changes size, so the clock section itself never reports being pushed down.
  const { to } = useLocalSearchParams<{ to?: string }>();
  const followClock = useRef(to === 'clock');
  const onOverviewLayout = (e: LayoutChangeEvent) => {
    if (!followClock.current) return;
    const { y, height } = e.nativeEvent.layout;
    // The content starts under the bar (paddingTop: BAR_HEIGHT), so this puts the clock section right under it.
    scroll.current?.scrollTo({ y: y + height, animated: !motion.reduce });
  };
  useEffect(() => {
    if (activity.isLoading || !followClock.current) return;
    const t = setTimeout(() => {
      followClock.current = false;
    }, JUMP_SETTLE_MS);
    return () => clearTimeout(t);
  }, [activity.isLoading]);

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView ref={scroll as never} contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <Overview d={data} activity={activity} onLayout={onOverviewLayout} />
              <ClockSection d={data} reload={reload} />
              <PlayersSection total={data.players.total} />
              <SystemSection d={data} />
            </OffsetProvider>
            <AdminFooter>צד הניהול · רק מנהלים רואים את העמוד הזה, וכל בקשה נבדקת שוב בשרת. תפקידים משתנים רק ב־SQL.</AdminFooter>
          </View>
        </Animated.ScrollView>

        <TopBar clock={data.clock} name={name} rankLine="מנהל" side="admin" adminTab="admin-dashboard" />
      </View>
    </MotionProvider>
  );
}

// ---------- 1. Overview ----------

type Activity = ReturnType<typeof useAdminActivity>;

function Overview({ d, activity, onLayout }: { d: AdminOverview; activity: Activity; onLayout: (e: LayoutChangeEvent) => void }) {
  const p = d.players;
  const pr = d.presence;
  return (
    <Section
      first
      onLayout={onLayout}
      eyebrow="לוח ניהול · ליגת תיקים"
      title={
        <>
          <Accent>{count(p.total)}</Accent>
          {` ${playersWord(p.total)}\nבליגה.`}
        </>
      }
      body={playersSummary(p)}
    >
      <CardRow>
        <Card inverse title="מחוברים עכשיו" sub="האפליקציה פתוחה אצלם ב־2 הדקות האחרונות" end={<Chip variant="up">חי</Chip>}>
          <BigNumber value={count(pr.onlineNow)} unit={playersWord(pr.onlineNow)} />
          <SubText>מתעדכן כל דקה.</SubText>
        </Card>
        <Card title="שחקנים היום" sub="כל שחקן נספר פעם אחת, גם אם נכנס כמה פעמים">
          <BigNumber value={count(pr.seenToday)} unit={playersWord(pr.seenToday)} />
          <SubText>{`${count(pr.visitsToday)} פתיחות היום בסך הכול.`}</SubText>
        </Card>
      </CardRow>
      <CardRow>
        <Card
          title="חזרו כמה פעמים היום"
          sub="פתיחה = כניסה אחרי 30 דקות ומעלה בלי האפליקציה"
          end={pr.avgVisits !== null ? <Chip>{`ממוצע ${pr.avgVisits} פתיחות`}</Chip> : null}
        >
          <BigNumber value={count(pr.returningToday)} unit={playersWord(pr.returningToday)} />
          <Tiles
            items={[
              { value: count(pr.visitBuckets.two), label: 'פעמיים' },
              { value: count(pr.visitBuckets.threeToFive), label: '3–5 פעמים' },
              { value: count(pr.visitBuckets.sixPlus), label: '6 פעמים ומעלה', solid: true },
            ]}
          />
        </Card>
      </CardRow>
      <CardRow>
        <Card title="הרשמות" sub="כל מי שנכנס לפחות פעם אחת" end={<Chip variant="up">{`${count(p.joinedToday)} היום`}</Chip>}>
          <BigNumber value={count(p.total)} unit={playersWord(p.total)} />
          <Tiles
            items={[
              { value: count(p.joinedToday), label: 'נרשמו היום' },
              { value: count(p.withHoldings), label: 'מחזיקים ניירות' },
              { value: count(p.total - p.withHoldings), label: 'רק במזומן', solid: true },
            ]}
          />
        </Card>
      </CardRow>
      <CardRow>
        <TrendCard activity={activity} />
      </CardRow>
    </Section>
  );
}

// Players per day for 30 days, and how many come back the next day and a week later (D-026).
// This is how the retention feature will be measured. The page loads the data (AdminView needs to know when it lands).
function TrendCard({ activity }: { activity: Activity }) {
  const { data, error, isLoading } = activity;
  const { colors } = useTheme();
  const p = usePalette();
  const days = data?.days ?? [];
  const max = Math.max(1, ...days.map((d) => d.activePlayers));
  const today = days[days.length - 1];

  return (
    <Card title="מגמה" sub="שחקנים פעילים ביום, 30 הימים האחרונים" end={today ? <Chip>{`היום: ${count(today.activePlayers)}`}</Chip> : null}>
      {error ? (
        <Empty>{error}</Empty>
      ) : isLoading || !data ? (
        <ActivityIndicator style={styles.spinner} color={colors.accent} />
      ) : (
        <>
          {/* Oldest on the left, today on the right, like the world clock's timeline. */}
          <View style={[styles.bars, ltr]} accessibilityLabel={`שחקנים פעילים ביום: היום ${today?.activePlayers ?? 0}`}>
            {days.map((d, i) => (
              <View
                key={d.date}
                style={[
                  styles.bar,
                  {
                    height: `${Math.max(3, (d.activePlayers / max) * 100)}%`,
                    backgroundColor: i === days.length - 1 ? colors.accent : d.activePlayers > 0 ? colors.line2 : colors.line,
                  },
                ]}
              />
            ))}
          </View>
          <View style={[styles.barAxis, ltr]}>
            <Text style={[styles.axisText, { color: p.sub }]}>{dateHe(days[0].date)}</Text>
            <Text style={[styles.axisText, { color: p.sub }]}>היום</Text>
          </View>
          <Tiles
            items={[
              { value: rateLabel(data.retention.d1.pct), label: `חזרו למחרת · מתוך ${count(data.retention.d1.cohort)}` },
              { value: rateLabel(data.retention.d7.pct), label: `חזרו אחרי שבוע · מתוך ${count(data.retention.d7.cohort)}`, solid: true },
            ]}
          />
          <SubText>מחושב רק על שחקנים שעבר מספיק זמן מההרשמה שלהם. כאן נמדוד את פיצ׳ר השימור.</SubText>
        </>
      )}
    </Card>
  );
}

// ---------- 2. World clock ----------

function ClockSection({ d, reload }: { d: AdminOverview; reload: () => void }) {
  const c = d.clock;
  const o = d.orders;
  const { colors } = useTheme();
  const clock = useClockAction(reload);
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (disarm.current) clearTimeout(disarm.current);
  }, []);

  const atEnd = c?.endsAt != null && c.at >= c.endsAt.at;
  const idle = clock.busy === null && c !== null;

  const onAdvance = () => {
    if (disarm.current) clearTimeout(disarm.current);
    if (!armed) {
      setArmed(true);
      disarm.current = setTimeout(() => setArmed(false), CONFIRM_MS);
      return;
    }
    setArmed(false);
    if (c) clock.run('advance', { from: c.at });
  };

  return (
    <Section
      alt
      eyebrow={c ? `שעון העולם · שבוע ${c.week}` : 'שעון העולם'}
      title={
        c ? (
          <>
            {`${dayLabel(c.weekday)} ${dateHe(c.date)}\n`}
            <Strong>{`${c.time}. `}</Strong>
            <Faint>{marketsLine(c)}</Faint>
          </>
        ) : (
          <>
            {'השעון\n'}
            <Accent>עוד לא הופעל.</Accent>
          </>
        )
      }
      body={clockSummary(c)}
      actions={
        <>
          <Button
            label={clock.busy === 'advance' ? 'מקדם…' : armed ? 'לחצו שוב לאישור' : advanceLabel(c)}
            variant={armed ? 'ink' : 'primary'}
            onPress={onAdvance}
            disabled={!idle || atEnd}
            hint={atEnd ? 'השעון הגיע לסוף המחירים' : 'מריץ את כל הפתיחות והסגירות שבדרך. אי אפשר לחזור אחורה'}
          />
          <Button
            label={clock.busy === 'stop' ? 'עוצר…' : clock.busy === 'start' ? 'מפעיל…' : c?.running ? 'עצור את השעון' : 'הפעל את השעון'}
            onPress={() => clock.run(c?.running ? 'stop' : 'start')}
            disabled={!idle || (!c?.running && atEnd)}
          />
        </>
      }
      after={
        clock.error || clock.outcome ? (
          <Text style={[styles.clockNote, { color: clock.error ? colors.negative : colors.muted }]}>
            {clock.error ?? (clock.outcome ? clockOutcomeLine(clock.outcome) : '')}
          </Text>
        ) : null
      }
    >
      <CardRow>
        <WorldClockCard clock={c} isAdmin={false} />
      </CardRow>
      <CardRow>
        <LastRunCard run={d.lastRun} behind={d.eventsBehind} />
        <Card
          title="תור הפקודות"
          sub="ממתינות לביצוע, לפי שוק"
          end={o.rejectedThisWeek > 0 ? <Chip variant="warn">{`${count(o.rejectedThisWeek)} נדחו השבוע`}</Chip> : null}
        >
          <Lines>
            <Line label="תל אביב" value={count(o.pending.tase)} strong />
            <Line label="ניו יורק" value={count(o.pending.us)} strong />
          </Lines>
          {o.rejectReasons.length > 0 ? (
            <SubText>{`דחייה נפוצה השבוע: ${o.rejectReasons.map((r) => `${r.reason} (${r.count})`).join(' · ')}`}</SubText>
          ) : (
            <SubText>אין דחיות השבוע.</SubText>
          )}
        </Card>
      </CardRow>
    </Section>
  );
}

// The latest open/close the engine ran (market_events, D-021), and whether it's falling behind.
function LastRunCard({ run, behind }: { run: AdminRunView | null; behind: number }) {
  const unbalanced = run?.ledgerBalanced === false;
  const chip = unbalanced ? (
    <Chip variant="down">היומן לא מאוזן</Chip>
  ) : behind > 0 ? (
    <Chip variant="warn">{`${count(behind)} אירועים מחכים`}</Chip>
  ) : run?.ledgerBalanced ? (
    <Chip variant="up">מאוזן</Chip>
  ) : null;

  return (
    <Card inverse title="הריצה האחרונה" sub="אם היומן לא מאוזן, הקידום הבא נחסם" end={chip}>
      {run ? (
        <>
          <SubText>{`${runLabel(run)} · ${dayLabel(run.at.weekday)} ${dateHe(run.at.date)} ${run.at.time} · ${RUN_STATUS[run.status]}`}</SubText>
          <Tiles
            items={[
              { value: count(run.ordersExecuted), label: 'בוצעו' },
              { value: count(run.ordersRejected), label: 'נדחו' },
              { value: run.durationMs === null ? '…' : `${(run.durationMs / 1000).toFixed(1)} ש׳`, label: 'משך' },
            ]}
          />
          <SubText>{`${count(run.playersUpdated)} שחקנים עודכנו.`}</SubText>
        </>
      ) : (
        <Empty>
          {behind > 0
            ? `${count(behind)} פתיחות וסגירות כבר הגיעו ועוד לא רצו. הטיקר יריץ אותן בדקה הקרובה.`
            : 'עוד לא רצה אף פתיחה או סגירה. כאן יופיעו כמה פקודות בוצעו וכמה נדחו, כמה זמן זה לקח, והאם היומן מאוזן.'}
        </Empty>
      )}
    </Card>
  );
}

// ---------- 3. Players ----------

function PlayersSection({ total }: { total: number }) {
  const [query, setQuery] = useState('');
  const list = useAdminPlayers(query);
  // More players than the API sends (PLAYERS_LIMIT): the rest are in the players' full leaderboard.
  const more = list.data !== null && total > list.data.limit;
  return (
    <Section
      eyebrow="שחקנים"
      title={
        <>
          <Accent>{count(total)}</Accent>
          {` ${playersWord(total)}\nלפי מקום השבוע.`}
        </>
      }
      body="צפייה בלבד. חיפוש לפי שם תצוגה או אימייל."
      actions={more ? <Button label="לטבלה המלאה" onPress={() => router.navigate('/leaderboard')} /> : null}
    >
      <CardRow>
        <PlayersCard query={query} onQuery={setQuery} list={list} />
      </CardRow>
    </Section>
  );
}

function PlayersCard({ query, onQuery, list }: { query: string; onQuery: (q: string) => void; list: ReturnType<typeof useAdminPlayers> }) {
  const { colors } = useTheme();
  const { data, error, isLoading } = list;
  const players = data?.players ?? [];

  return (
    <Card title="כל השחקנים" sub="מקום בשבוע הנוכחי, ואז לפי שווי התיק">
      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="חיפוש: שם או אימייל"
        placeholderTextColor={colors.faint}
        accessibilityLabel="חיפוש שחקן"
        maxLength={100}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.search, { backgroundColor: colors.surface2, borderColor: colors.line2, color: colors.fg }]}
      />
      {error ? (
        <Empty>{error}</Empty>
      ) : isLoading && !data ? (
        <ActivityIndicator style={styles.spinner} color={colors.accent} />
      ) : players.length === 0 ? (
        <Empty>{query.trim() ? 'אף שחקן לא מתאים לחיפוש.' : 'עוד אין שחקנים.'}</Empty>
      ) : (
        // The table keeps its width on phones and scrolls sideways inside the card.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll} contentContainerStyle={styles.tableContent}>
          <View style={styles.table}>
            <PlayerHeader />
            {players.map((p) => (
              <PlayerRow key={p.uid} player={p} />
            ))}
          </View>
        </ScrollView>
      )}
      {data && players.length === data.limit ? <SubText>{`מוצגים ${data.limit} הראשונים. חפשו כדי למצוא שחקן אחר.`}</SubText> : null}
    </Card>
  );
}

// Fixed columns + the name's minimum + the gaps = the table's minimum width (styles.table). It must fit the
// card's inner width on a wide screen (about 606px), or the last column scrolls out of sight.
const COLS = { rank: 44, value: 108, pending: 64, visits: 76, seen: 100 };

function PlayerHeader() {
  const { colors } = useTheme();
  const cell = [styles.th, { color: colors.faint }];
  return (
    <View style={[styles.tr, { borderBottomColor: colors.line }]}>
      <Text style={[cell, { width: COLS.rank }]}>מקום</Text>
      <Text style={[cell, styles.nameCol]}>שחקן</Text>
      <Text style={[cell, { width: COLS.value }]}>שווי תיק</Text>
      <Text style={[cell, { width: COLS.pending }]}>ממתינות</Text>
      <Text style={[cell, { width: COLS.visits }]}>פתיחות היום</Text>
      <Text style={[cell, { width: COLS.seen }]}>נראה לאחרונה</Text>
    </View>
  );
}

function PlayerRow({ player: p }: { player: AdminPlayer }) {
  const { colors } = useTheme();
  const seen = lastSeenLabel(p.lastSeenAt, Date.now());
  const online = seen === 'מחובר';
  return (
    <View style={[styles.tr, { borderBottomColor: colors.line }]}>
      <Text style={[styles.td, styles.num, { width: COLS.rank, color: colors.faint }]}>{p.rank ? `#${p.rank}` : '—'}</Text>
      <View style={styles.nameCol}>
        <View style={styles.nameLine}>
          <Text style={[styles.td, styles.name, { color: colors.fg }]} numberOfLines={1}>{p.name ?? 'ללא שם תצוגה'}</Text>
          {p.isAdmin ? <Chip variant="up">מנהל</Chip> : null}
        </View>
        <Text style={[styles.email, ltr, { color: colors.faint }]} numberOfLines={1}>{p.email}</Text>
      </View>
      <Text style={[styles.td, styles.num, { width: COLS.value, color: colors.fg }]}>{ils(p.totalValue)}</Text>
      <Text style={[styles.td, styles.num, { width: COLS.pending, color: colors.muted }]}>{count(p.pendingOrders)}</Text>
      <Text style={[styles.td, styles.num, { width: COLS.visits, color: colors.muted }]}>{count(p.visitsToday)}</Text>
      <View style={[styles.seenCell, { width: COLS.seen }]}>
        {online ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
        <Text style={[styles.td, { color: online ? colors.accent : colors.muted }]} numberOfLines={1}>{seen}</Text>
      </View>
    </View>
  );
}

// ---------- 4. System ----------

function SystemSection({ d }: { d: AdminOverview }) {
  const w = d.world;
  const loaded = w.securities > 0;
  return (
    <Section
      alt
      eyebrow="מערכת"
      title={
        loaded ? (
          <>
            {`${w.securities} ניירות.\n`}
            <Accent>{w.pricesUntil.tase ? `מחירים עד ${dateHe(w.pricesUntil.tase)}.` : 'אין עדיין מחירים.'}</Accent>
          </>
        ) : (
          <>
            {'העולם\n'}
            <Accent>עוד לא נטען.</Accent>
          </>
        )
      }
      body="מה שצריך לדעת כשאף אחד לא ליד המחשב."
    >
      <CardRow>
        <Card inverse title="מצב הנתונים" sub="השרת והמסד ענו, אחרת העמוד לא היה נטען" end={<Chip variant={loaded ? 'up' : 'warn'}>{loaded ? 'תקין' : 'חסר'}</Chip>}>
          <Lines>
            <Line label="ניירות בעולם" value={loaded ? String(w.securities) : 'לא נטענו'} warn={!loaded} />
            <Line label="מחירי תל אביב עד" value={w.pricesUntil.tase ? dateHe(w.pricesUntil.tase) : '—'} warn={!w.pricesUntil.tase} />
            <Line label="מחירי ניו יורק עד" value={w.pricesUntil.us ? dateHe(w.pricesUntil.us) : '—'} warn={!w.pricesUntil.us} />
            <Line label="שער הדולר עד" value={w.usdIlsUntil ? dateHe(w.usdIlsUntil) : '—'} warn={!w.usdIlsUntil} />
            <Line label="השעון נעצר ב־" value={d.clock?.endsAt ? dateHe(d.clock.endsAt.date) : '—'} />
          </Lines>
          {!loaded ? <SubText>להרצה: npm run seed:world בתיקיית api.</SubText> : null}
        </Card>
        <ActionLogCard actions={d.recentActions} />
      </CardRow>
    </Section>
  );
}

// The newest admin actions (admin_actions), written by the clock endpoints in the same transaction.
function ActionLogCard({ actions }: { actions: AdminActionView[] }) {
  const p = usePalette();
  const now = Date.now();
  return (
    <Card title="יומן פעולות ניהול" sub="מי עשה מה, ומתי" end={actions.length > 0 ? <Chip>{`${actions.length} אחרונות`}</Chip> : null}>
      {actions.length === 0 ? (
        <Empty>עוד אין פעולות. כל קידום, עצירה או הפעלה של השעון יירשמו כאן: מי, מתי, וכמה פקודות רצו.</Empty>
      ) : (
        <Lines>
          {actions.map((a, i) => (
            <View key={`${a.at}-${i}`} style={[styles.line, { borderTopColor: p.line }]}>
              <Text style={[styles.logTime, styles.num, { color: p.sub }]}>{realTimeLabel(a.at, now)}</Text>
              <Text style={[styles.lineLabel, { color: p.fg }]} numberOfLines={2}>{`${a.admin} ${actionLabel(a)}`}</Text>
            </View>
          ))}
        </Lines>
      )}
    </Card>
  );
}

// BigNumber, Tiles, Line and SubText live in components/admin/AdminBits.tsx, shared with /admin-monitoring.

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 64 },
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  num: { fontVariant: ['tabular-nums'] },
  // The action log's rows look like AdminBits' Line, with a time in place of the dot. The dot is the
  // players table's "online" mark.
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  lineLabel: { fontSize: 13.5, flex: 1 },
  search: { marginTop: 14, borderWidth: 1, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, fontSize: 13, textAlign: 'right', minHeight: 44 },
  spinner: { marginTop: 20 },
  tableScroll: { marginTop: 12 },
  tableContent: { flexGrow: 1 },
  table: { flexGrow: 1, minWidth: 572 },   // 392 of COLS + 140 for the name + 5 gaps of 8
  seenCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 96, marginTop: 16 },
  bar: { flex: 1, borderRadius: 3, minWidth: 2 },
  barAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisText: { fontSize: 10.5 },
  logTime: { fontSize: 12, width: 78 },
  clockNote: { fontSize: 14, lineHeight: 21, marginTop: 14, maxWidth: 520 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderBottomWidth: 1 },
  // textAlign right on every cell: a number or an email has no Hebrew letter, so the browser would set it
  // left-to-right and push it to the left of its column, away from its Hebrew header.
  th: { fontSize: 12, fontWeight: '500', textAlign: 'right' },
  td: { fontSize: 13.5, textAlign: 'right' },
  nameCol: { flex: 1, minWidth: 140 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1 },
  email: { fontSize: 11.5, marginTop: 1, textAlign: 'right' },
});
