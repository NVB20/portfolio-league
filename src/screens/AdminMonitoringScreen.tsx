// The monitoring page (/admin-monitoring, D-036): how players use the app, and whether the database is well.
// Reached from the "ניטור" tab on the admin side. Only admins can open it (_layout.tsx), and the API checks the
// role again on every request.
//
// Same look as /admin-dashboard: scrolling sections with a headline and rows of cards, one inverse card per
// section where there are two. Design: assignment/admin-monitoring-design.md.
//   1. Orders, the confirm popup and the stop loss (D-037), for the range picked in the headline (today / 7 days /
//      30 days)
//   2. Pages: which player page gets the most time, views and players, in the same range
//   3. Usage time: one bar per day (30) or per week (12), stacked by page, so a bar's height is all the time in
//      the app and its parts are the time per page
//   4. Database: reachable, latency, connections, size, the largest tables. Refreshes every 30 s
// Usage is real time and real Israel dates (like presence, D-026), never the world clock. Orders come from the
// orders table; popup opens and back-outs come from the app's check-ins. Before anything was measured the cards
// say so: nothing here is a made-up number.

import { ReactNode, useMemo, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AdminDbHealth, AdminMonitoring, MonitoringPageRow, MonitoringRange, MonitoringTotals, UsageBucket, UsagePage } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { light } from '../theme';
import type { Theme } from '../types/user';
import { useAdminDb, useAdminMonitoring } from '../admin/useAdmin';
import { count, playersWord } from '../admin/copy';
import {
  type Bar,
  type ChartUnit,
  averageLabel,
  averageNote,
  barReadout,
  bucketLabel,
  bucketSpoken,
  bytes,
  cacheText,
  clockTime,
  confirmNote,
  DB_WARN,
  dbFailure,
  dbStatus,
  duration,
  durationSpoken,
  latencyNumber,
  noUsageText,
  ordersSent,
  PAGE_LABEL,
  PAGES,
  percent,
  perPlayer,
  poolInUse,
  queryTime,
  RANGE_TEXT,
  RANGES,
  rowsText,
  share,
  shortDate,
  stack,
  stopNote,
  totalMs,
  UNIT_WINDOW,
  UNITS,
  uptime,
  usageSummary,
  viewsWord,
} from '../admin/monitoring';
import { AdminFallback, AdminFooter, BigNumber, Line, Lines, SubText, Tiles } from '../components/admin/AdminBits';
import { Card, Empty, usePalette } from '../components/dashboard/Card';
import { CardRow } from '../components/dashboard/CardRow';
import { Chip } from '../components/dashboard/Chip';
import { MAX_WIDTH, ltr, rtl } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { Accent, Faint, Section, Strong } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { Segmented } from '../components/leaderboard/Segmented';

// The four pages' colors in the usage chart, and their swatches in the pages list. The only colors on this page
// that aren't theme tokens, so they live here once. Checked with the dataviz palette validator against each
// theme's card surface (#FFFFFF light, #0E2233 dark): every two neighbors in a bar, and every two pages one apart
// (they touch when the page between them is zero), stay apart for colour-blind readers too (ΔE ≥ 8.4, normal
// vision ≥ 19.5). Trade wears the brand green: theme.ts's accent in light; in dark a deeper mint, because the
// accent itself is too light for a filled bar. Only the two ends, סקירה and טבלה, can look alike, and they touch
// only on a bar where both מסחר and יומן are zero. Light yellow is under 3:1 on white, so every page's time is
// also written in the legend: color never carries a number alone.
const PAGE_COLORS: Record<Theme, Record<UsagePage, string>> = {
  light: { dashboard: '#2a78d6', trade: light.accent, journal: '#eda100', leaderboard: '#6250d6' },
  dark: { dashboard: '#3987e5', trade: '#199e70', journal: '#c98500', leaderboard: '#9085e9' },
};

function usePageColors() {
  return PAGE_COLORS[useTheme().theme];
}

// The chart's plot: its height, the y-axis column beside it, the gap cut between stacked parts and between
// bars, and the widest a bar gets (on a wide card a 12-week bar would otherwise be a block).
const PLOT_H = 150;
const AXIS_W = 46;
const GAP = 2;
const BAR_MAX_W = 24;
const LABEL_HALF = 7;   // half an axis label's line height, to center a label on its gridline
const DB_EVERY_TEXT = 'כל 30 שניות';

type Db = ReturnType<typeof useAdminDb>;

export default function AdminMonitoringScreen() {
  const { user } = useAuth();
  const { data, error, isLoading, reload } = useAdminMonitoring();
  // Started here, not in the page, so a failed first load can tell "the database is down" from any other error.
  const db = useAdminDb();
  const name = user?.displayName || user?.email?.split('@')[0] || 'מנהל';
  const bar = <TopBar clock={null} name={name} rankLine="מנהל" side="admin" adminTab="admin-monitoring" />;

  if (data) return <MonitoringView data={data} db={db}>{bar}</MonitoringView>;

  const why = db.error ? dbFailure(db.error, db.denied).page : error;
  return (
    <AdminFallback isLoading={isLoading} error={why} onRetry={reload}>
      {bar}
    </AdminFallback>
  );
}

function MonitoringView({ data, db, children }: { data: AdminMonitoring; db: Db; children: ReactNode }) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);
  // A week shows a picture even on a quiet day; today alone is often empty early in the morning.
  const [range, setRange] = useState<MonitoringRange>('d7');

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <Header d={data} range={range} onRange={setRange} />
              <PagesSection d={data} range={range} />
              <UsageSection d={data} />
              <DbSection db={db} />
            </OffsetProvider>
            <AdminFooter>
              צד הניהול · רק מנהלים רואים את העמוד הזה, וכל בקשה נבדקת שוב בשרת. הזמנים והתאריכים כאן אמיתיים (שעון ישראל), לא שעון העולם. המספרים לניהול בלבד: לא לניקוד ולא לכסף.
            </AdminFooter>
          </View>
        </Animated.ScrollView>

        {children}
      </View>
    </MotionProvider>
  );
}

// ---------- 1. Orders and the confirm popup ----------

function Header({ d, range, onRange }: { d: AdminMonitoring; range: MonitoringRange; onRange: (r: MonitoringRange) => void }) {
  const t = d.totals[range];
  return (
    <Section
      first
      eyebrow="ניטור · ליגת תיקים"
      title={
        <>
          <Accent>{count(t.orders.sent)}</Accent>
          {` ${ordersSent(t.orders.sent)}\n${RANGE_TEXT[range]}.`}
        </>
      }
      body={usageSummary(t, d.since, range)}
      actions={<Segmented options={RANGES} value={range} onChange={onRange} label="טווח הזמן של הפקודות, חלון האישור, הסטופ לוס והעמודים" />}
    >
      <CardRow>
        <OrdersCard o={t.orders} />
        <ConfirmCard confirms={t.confirms} sent={t.orders.sent} since={d.since} range={range} />
      </CardRow>
      <CardRow>
        <StopLossCard s={t.stops} now={d.stopsNow} range={range} />
      </CardRow>
    </Section>
  );
}

// The stop loss (D-037): how many players used it in the range, out of those who bought, how many buys carried
// one, and how many fired. Straight from the orders table, like the orders card. "Active now" doesn't follow the
// range: it is the stops waiting right now.
function StopLossCard({ s, now, range }: { s: MonitoringTotals['stops']; now: AdminMonitoring['stopsNow']; range: MonitoringRange }) {
  const p = usePalette();
  const used = share(s.players, s.buyers);
  const withStop = share(s.withStop, s.buys);
  return (
    <Card
      title="סטופ לוס"
      sub="כמה שחקנים שמים סטופ לוס על הקניות שלהם"
      end={used !== null ? <Chip>{`${percent(used)} מהקונים`}</Chip> : null}
    >
      <BigNumber value={count(s.players)} unit={`${playersWord(s.players)} השתמשו בסטופ לוס`} />
      <Tiles
        items={[
          { value: count(s.withStop), label: `קניות עם סטופ · ${percent(withStop)} מהקניות` },
          { value: count(s.fired), label: 'סטופים שהופעלו' },
          { value: count(s.moved), label: `הזזות סטופ · ${count(s.movers)} ${playersWord(s.movers)}` },
          { value: count(now.active), label: `פעילים עכשיו · ${count(now.players)} ${playersWord(now.players)}`, solid: true },
        ]}
      />
      <Meter label="קניות עם סטופ לוס, מתוך כל הקניות" value={percent(withStop)} part={withStop} color={p.accentFill} />
      <SubText>{stopNote(s, range)}</SubText>
    </Card>
  );
}

// Orders sent in the range, by where they stand now. Straight from the orders table, so it is real even before
// any usage was measured.
function OrdersCard({ o }: { o: MonitoringTotals['orders'] }) {
  return (
    <Card
      inverse
      title="פקודות"
      sub="שנשלחו בטווח, לפי המצב שלהן עכשיו"
      end={o.rejected > 0 ? <Chip variant="warn">{`${percent(share(o.rejected, o.sent))} נדחו`}</Chip> : null}
    >
      <BigNumber value={count(o.sent)} unit={ordersSent(o.sent)} />
      <Tiles
        items={[
          { value: count(o.executed), label: 'בוצעו' },
          { value: count(o.rejected), label: 'נדחו' },
          { value: count(o.pending), label: 'ממתינות לביצוע', solid: true },
        ]}
      />
      <SubText>מטבלת הפקודות, לפי זמן השליחה האמיתי ולא לפי שעון העולם. ממתינה = עוד לא בוצעה ולא נדחתה.</SubText>
    </Card>
  );
}

// "שלח פקודת קנייה/מכירה" opens a confirm popup. Opened and backed out come from the app; sent from the orders table.
function ConfirmCard({ confirms: c, sent, since, range }: {
  confirms: MonitoringTotals['confirms'];
  sent: number;
  since: string | null;
  range: MonitoringRange;
}) {
  const p = usePalette();
  const backed = share(c.backed, c.opened);
  return (
    <Card
      title="חלון האישור"
      sub="׳שלח פקודה׳ פותח חלון אישור. כמה המשיכו, וכמה חזרו?"
      end={backed !== null ? <Chip>{`${percent(backed)} חזרו`}</Chip> : null}
    >
      {since === null ? (
        <Empty>{noUsageText(null, '')}</Empty>
      ) : (
        <>
          <Tiles
            items={[
              { value: count(c.opened), label: 'פתחו את החלון' },
              { value: count(sent), label: 'פקודות נשלחו' },
              { value: count(c.backed), label: 'חזרו בלי לשלוח' },
            ]}
          />
          <Meter label="חזרו בלי לשלוח, מתוך הפתיחות" value={percent(backed)} part={backed} color={p.warn} />
          <SubText>{confirmNote(c, sent, range)}</SubText>
        </>
      )}
    </Card>
  );
}

// ---------- 2. Pages ----------

function PagesSection({ d, range }: { d: AdminMonitoring; range: MonitoringRange }) {
  const t = d.totals[range];
  const top = t.pages[0];
  const rangeName = RANGES.find((r) => r.value === range)?.label ?? '';
  return (
    <Section
      alt
      eyebrow="עמודים"
      title={
        top ? (
          <>
            {'הכי הרבה זמן\nבעמוד '}
            <Accent>{PAGE_LABEL[top.page]}</Accent>
            {'.'}
          </>
        ) : (
          <>
            {'העמודים\n'}
            <Accent>עוד בלי שימוש.</Accent>
          </>
        )
      }
      body={`לפי הטווח שנבחר למעלה: ${rangeName}. זמן נספר רק כשהעמוד גלוי ומישהו השתמש בו ב־5 הדקות האחרונות.`}
    >
      <CardRow>
        <PagesCard t={t} since={d.since} range={range} />
      </CardRow>
    </Section>
  );
}

function PagesCard({ t, since, range }: { t: MonitoringTotals; since: string | null; range: MonitoringRange }) {
  const unused = PAGES.filter((page) => !t.pages.some((r) => r.page === page));
  return (
    <Card
      title="זמן, צפיות ושחקנים לפי עמוד"
      sub="הכי הרבה זמן למעלה. הפס = החלק של העמוד מכל הזמן באפליקציה"
      end={t.players > 0 ? <Chip>{`${count(t.players)} ${playersWord(t.players)}`}</Chip> : null}
    >
      {t.pages.length === 0 ? (
        <Empty>{noUsageText(since, RANGE_TEXT[range])}</Empty>
      ) : (
        <View style={styles.pageRows}>
          {t.pages.map((row, i) => (
            <PageRow key={row.page} row={row} rank={i + 1} total={t.ms} />
          ))}
        </View>
      )}
      {t.pages.length > 0 && unused.length > 0 ? (
        <SubText>{`לא נפתחו ${RANGE_TEXT[range]}: ${unused.map((page) => PAGE_LABEL[page]).join(', ')}.`}</SubText>
      ) : null}
    </Card>
  );
}

function PageRow({ row, rank, total }: { row: MonitoringPageRow; rank: number; total: number }) {
  const p = usePalette();
  const pageColors = usePageColors();
  const part = share(row.ms, total);
  const views = `${count(row.views)} ${viewsWord(row.views)}`;
  const players = `${count(row.players)} ${playersWord(row.players)}`;
  return (
    <View
      accessible
      accessibilityLabel={`${rank}. ${PAGE_LABEL[row.page]}: ${durationSpoken(row.ms)}, ${percent(part)} מהזמן, ${views}, ${players}`}
      style={[styles.pageRow, { borderTopColor: p.line }]}
    >
      <View style={styles.pageHead}>
        <View style={[styles.swatch, { backgroundColor: pageColors[row.page] }]} />
        <Text style={[styles.pageName, { color: p.fg }]}>{PAGE_LABEL[row.page]}</Text>
        <Text style={[styles.pageTime, styles.num, { color: p.fg }]}>{duration(row.ms)}</Text>
      </View>
      {/* Fills left to right, like the holding cards' weight bars. */}
      <View style={[styles.track, ltr, { backgroundColor: p.line }]}>
        {part ? <View style={[styles.fill, { width: `${part * 100}%`, backgroundColor: pageColors[row.page] }]} /> : null}
      </View>
      <View style={styles.pageFoot}>
        <Text style={[styles.pageMeta, { color: p.sub }]}>{`${views} · ${players}`}</Text>
        <Text style={[styles.pageMeta, styles.num, { color: p.sub }]}>{`${percent(part)} מהזמן`}</Text>
      </View>
    </View>
  );
}

// ---------- 3. Usage time ----------

function UsageSection({ d }: { d: AdminMonitoring }) {
  const [unit, setUnit] = useState<ChartUnit>('day');
  const [only, setOnly] = useState<UsagePage | null>(null);   // a page picked in the legend; null = all
  const buckets = unit === 'day' ? d.daily : d.weekly;
  const all = totalMs(buckets);
  return (
    <Section
      eyebrow="זמן שימוש"
      title={
        d.since === null ? (
          <>
            {'זמן השימוש\n'}
            <Accent>עוד לא נמדד.</Accent>
          </>
        ) : (
          <>
            <Accent>{duration(all)}</Accent>
            {`\nבאפליקציה ב־${UNIT_WINDOW[unit]}.`}
          </>
        )
      }
      body="כל עמודה היא כל הזמן באפליקציה באותו יום או שבוע, מחולקת לפי עמוד. לחיצה על עמוד במקרא מציגה רק אותו. שבוע מתחיל ביום שני, כמו שבוע המשחק."
      actions={<Segmented options={UNITS} value={unit} onChange={setUnit} label="עמודה לכל יום או לכל שבוע" />}
    >
      <CardRow>
        {/* key: a new unit starts with its latest bar picked. */}
        <UsageCard key={unit} buckets={buckets} unit={unit} only={only} onOnly={setOnly} since={d.since} all={all} />
      </CardRow>
    </Section>
  );
}

function UsageCard({ buckets, unit, only, onOnly, since, all }: {
  buckets: UsageBucket[];
  unit: ChartUnit;
  only: UsagePage | null;
  onOnly: (page: UsagePage | null) => void;
  since: string | null;
  all: number;   // every page's time in the window, whatever the legend shows
}) {
  const { colors } = useTheme();
  const p = usePalette();
  const s = useMemo(() => stack(buckets, only), [buckets, only]);
  const last = s.bars.length - 1;
  // The bar the line above the chart and the legend describe: hover, focus or tap picks one; the latest by default.
  const [picked, setPicked] = useState(last);
  const index = Math.min(Math.max(0, picked), last);
  const avg = perPlayer(s.total, s.playerBuckets);
  const scope = only ? ` · ${PAGE_LABEL[only]}` : '';
  const sub = unit === 'day' ? 'עמודה לכל יום, 30 הימים האחרונים' : 'עמודה לכל שבוע, 12 השבועות האחרונים';

  let body;
  if (since === null) {
    body = <Empty>{noUsageText(null, '')}</Empty>;
  } else if (last < 0 || all === 0) {
    body = <Empty>{noUsageText(since, `ב־${UNIT_WINDOW[unit]}`)}</Empty>;
  } else {
    const bar = s.bars[index];
    const label = bucketLabel(bar.start, unit, index === last);
    body = (
      <>
        <View style={styles.readout}>
          <Text style={[styles.readoutLabel, { color: p.fg }]}>{label}</Text>
          <Text style={[styles.readoutValue, styles.num, { color: p.sub }]}>{barReadout(bar, only)}</Text>
        </View>

        {/* Oldest on the left, the current day or week on the right, like the trend card on the admin dashboard. */}
        <View
          style={[styles.plotRow, ltr]}
          accessibilityLabel={`גרף עמודות: זמן באפליקציה ${unit === 'day' ? 'ביום' : 'בשבוע'}, ${UNIT_WINDOW[unit]}${scope}. סך הכול ${durationSpoken(s.total)}. כל עמודה היא כפתור שמקריא את הפירוט שלה.`}
        >
          <YAxis top={s.top} />
          <View style={[styles.plot, { height: PLOT_H }]}>
            <View style={[styles.grid, { top: 0, backgroundColor: p.line }]} />
            <View style={[styles.grid, { top: PLOT_H / 2, backgroundColor: p.line }]} />
            <View style={[styles.grid, { bottom: 0, backgroundColor: colors.line2 }]} />
            <View style={styles.bars}>
              {s.bars.map((b, i) => (
                <BarSlot
                  key={b.start}
                  bar={b}
                  top={s.top}
                  on={i === index}
                  onPick={() => setPicked(i)}
                  label={bucketSpoken(buckets[i], bucketLabel(b.start, unit, i === last), only)}
                />
              ))}
            </View>
          </View>
        </View>
        <View style={[styles.xAxis, ltr]}>
          <Text style={[styles.axisText, rtl, { color: p.sub }]}>{shortDate(s.bars[0].start)}</Text>
          <Text style={[styles.axisText, rtl, { color: p.sub }]}>{unit === 'day' ? 'היום' : 'השבוע'}</Text>
        </View>

        <Legend bucket={buckets[index]} only={only} onOnly={onOnly} />
        <Tiles
          items={[
            { value: duration(s.total), label: `סך הכול · ${UNIT_WINDOW[unit]}${scope}` },
            { value: avg === null ? '—' : duration(avg), label: averageLabel(unit, only), solid: true },
          ]}
        />
        <SubText>{averageNote(unit, only)}</SubText>
      </>
    );
  }

  return (
    <Card title="זמן באפליקציה, לפי עמוד" sub={sub} end={only ? <Chip>{`רק ${PAGE_LABEL[only]}`}</Chip> : null}>
      {body}
    </Card>
  );
}

// The plot's scale: the top, the middle and zero, beside the gridlines.
function YAxis({ top }: { top: number }) {
  const p = usePalette();
  const label = [styles.axisText, styles.yLabel, rtl, { color: p.sub }];
  return (
    <View style={[styles.yAxis, { height: PLOT_H }]}>
      <Text style={[label, { top: -LABEL_HALF }]}>{duration(top)}</Text>
      <Text style={[label, { top: PLOT_H / 2 - LABEL_HALF }]}>{duration(top / 2)}</Text>
      <Text style={[label, { bottom: -LABEL_HALF }]}>0</Text>
    </View>
  );
}

// One bar: its pages stacked from the baseline up, a 2px cut between them in the color behind the bar, and a
// rounded top. The whole column is the hit area, not only the painted part, so a short bar is easy to pick.
function BarSlot({ bar, top, on, onPick, label }: { bar: Bar; top: number; on: boolean; onPick: () => void; label: string }) {
  const { colors } = useTheme();
  const p = usePalette();
  const pageColors = usePageColors();
  const behind = on ? p.tile : colors.surface;
  const parts = [...bar.segments].reverse();   // drawn top first
  return (
    <Pressable
      onPress={onPick}
      onHoverIn={onPick}
      onFocus={onPick}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={[styles.slot, on && { backgroundColor: p.tile }]}
    >
      <View style={styles.bar}>
        {parts.map((seg, i) => {
          // A part too thin to lose 2px to the cut keeps its color whole; at least 1px so it still shows.
          const h = Math.max(1, (seg.ms / top) * PLOT_H);
          const cut = i < parts.length - 1 && h > GAP + 1 ? GAP : 0;
          return (
            <View
              key={seg.page}
              style={[
                { height: h, backgroundColor: pageColors[seg.page], borderBottomWidth: cut, borderBottomColor: behind },
                i === 0 && styles.barEnd,
              ]}
            />
          );
        })}
      </View>
    </Pressable>
  );
}

// The pages, with the picked bar's time on each. Tapping a page shows only it; tapping it again shows all.
function Legend({ bucket, only, onOnly }: { bucket: UsageBucket; only: UsagePage | null; onOnly: (page: UsagePage | null) => void }) {
  const p = usePalette();
  const pageColors = usePageColors();
  return (
    <View style={styles.legend}>
      {PAGES.map((page) => {
        const on = only === page;
        const dim = only !== null && !on;
        return (
          <Pressable
            key={page}
            onPress={() => onOnly(on ? null : page)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            aria-checked={on}   // react-native-web ignores accessibilityState
            accessibilityLabel={`רק ${PAGE_LABEL[page]} בגרף · ${durationSpoken(bucket.ms[page])} בעמודה שנבחרה`}
            accessibilityHint={on ? 'מחזיר את כל העמודים לגרף' : 'מציג בגרף רק את העמוד הזה'}
            style={({ pressed }) => [styles.legendItem, { borderColor: on ? p.fg : p.line }, (on || pressed) && { backgroundColor: p.tile }]}
          >
            <View style={[styles.swatch, { backgroundColor: pageColors[page] }, dim && styles.dim]} />
            <Text style={[styles.legendText, { color: dim ? p.sub : p.fg }]}>{PAGE_LABEL[page]}</Text>
            <Text style={[styles.legendValue, styles.num, { color: p.sub }]}>{duration(bucket.ms[page])}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- 4. Database ----------

function DbSection({ db }: { db: Db }) {
  const h = db.error ? null : db.data;
  return (
    <Section
      alt
      eyebrow="מסד הנתונים"
      title={
        db.error ? (
          <>
            {'המסד\n'}
            <Strong>{dbFailure(db.error, db.denied).title}</Strong>
          </>
        ) : h ? (
          <>
            {'המסד עונה\nתוך '}
            <Accent>{`${latencyNumber(h.latencyMs)} ms.`}</Accent>
          </>
        ) : (
          <>
            {'המסד\n'}
            <Faint>בבדיקה…</Faint>
          </>
        )
      }
      body={`מתעדכן ${DB_EVERY_TEXT} כשהעמוד פתוח וגלוי. קריאה בלבד: אין כאן שום פעולה שמשנה משהו.`}
    >
      <CardRow>
        <DbCard db={db} />
        {h ? <ConnectionsCard h={h} /> : null}
      </CardRow>
      {h ? (
        <CardRow>
          <TablesCard tables={h.tables} />
        </CardRow>
      ) : null}
    </Section>
  );
}

function DbCard({ db }: { db: Db }) {
  const p = usePalette();
  const h = db.error ? null : db.data;
  const status = h ? dbStatus(h) : null;
  const failed = db.error ? dbFailure(db.error, db.denied) : null;
  const s = h?.server;
  return (
    <Card
      inverse
      title="מצב המסד"
      sub={h ? `נבדק ב־${clockTime(h.checkedAt)} · שוב בעוד 30 שניות` : `נבדק ${DB_EVERY_TEXT}`}
      end={
        failed ? <Chip variant={db.denied ? 'warn' : 'down'}>{failed.chip}</Chip> : status ? <Chip variant={status.variant}>{status.label}</Chip> : null
      }
    >
      {failed ? (
        <>
          <Empty>{failed.text}</Empty>
          <SubText>{failed.note}</SubText>
        </>
      ) : !h || !s ? (
        <ActivityIndicator style={styles.spinner} color={p.accentFill} />
      ) : (
        <>
          <BigNumber value={latencyNumber(h.latencyMs)} unit="ms · זמן התגובה של SELECT 1 מה־API" />
          <Lines>
            <Line label="גרסה" value={`PostgreSQL ${s.version}`} />
            <Line label="פועל כבר" value={uptime(s.startedAt, Date.parse(h.checkedAt))} />
            <Line label="גודל המסד" value={bytes(s.sizeBytes)} />
            <Line label="קריאות מהזיכרון" value={cacheText(s.cacheHitPct)} warn={s.cacheHitPct !== null && s.cacheHitPct < DB_WARN.cacheHitPct} />
            <Line
              label="השאילתה הארוכה שרצה עכשיו"
              value={queryTime(s.longestQuerySec)}
              warn={s.longestQuerySec !== null && s.longestQuerySec >= DB_WARN.longQuerySec}
            />
          </Lines>
        </>
      )}
    </Card>
  );
}

// The API's own pool (how many of its connections are busy, and whether requests queue for one), and every
// client connection on the server against its max_connections.
function ConnectionsCard({ h }: { h: AdminDbHealth }) {
  const p = usePalette();
  const { pool } = h;
  const c = h.server.connections;
  const full = share(c.total, c.max);
  const near = full !== null && full >= DB_WARN.connectionsShare;
  return (
    <Card
      title="חיבורים"
      sub="של ה־API, ושל כל השרת"
      end={pool.waiting > 0 ? <Chip variant="warn">{`${count(pool.waiting)} מחכים`}</Chip> : <Chip>{`עד ${count(pool.max)} ל־API`}</Chip>}
    >
      <Tiles
        items={[
          { value: count(poolInUse(pool)), label: `בשימוש מתוך ${count(pool.max)}` },
          { value: count(pool.idle), label: 'פנויים' },
          { value: count(pool.waiting), label: 'בקשות מחכות לחיבור' },
        ]}
      />
      <Meter label="חיבורים לשרת" value={`${count(c.total)} מתוך ${count(c.max)}`} part={full} color={near ? p.warn : p.accentFill} />
      <Lines>
        <Line label="מריצים שאילתה" value={count(c.active)} />
        <Line label="פתוחים וממתינים" value={count(c.idle)} />
        <Line label="תקועים באמצע טרנזקציה" value={count(c.idleInTransaction)} warn={c.idleInTransaction > 0} />
      </Lines>
    </Card>
  );
}

function TablesCard({ tables }: { tables: AdminDbHealth['tables'] }) {
  return (
    <Card title="הטבלאות הגדולות" sub="5 הגדולות, עם האינדקסים. מספר השורות הוא ההערכה של Postgres">
      {tables.length === 0 ? (
        <Empty>אין טבלאות בסכמה public.</Empty>
      ) : (
        <Lines>
          {tables.map((t) => (
            <Line key={t.name} label={t.name} value={`${bytes(t.bytes)} · ${rowsText(t.rows)}`} />
          ))}
        </Lines>
      )}
    </Card>
  );
}

// ---------- small pieces ----------

// One share as a thin bar under its label and value: the back-out rate, the server's connections.
function Meter({ label, value, part, color }: { label: string; value: string; part: number | null; color: string }) {
  const p = usePalette();
  return (
    <View style={styles.meter} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.meterHead}>
        <Text style={[styles.meterLabel, { color: p.fg }]}>{label}</Text>
        <Text style={[styles.meterValue, styles.num, { color: p.fg }]}>{value}</Text>
      </View>
      <View style={[styles.track, ltr, { backgroundColor: p.line }]}>
        {part ? <View style={[styles.fill, { width: `${Math.min(1, part) * 100}%`, backgroundColor: color }]} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 64 },
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  num: { fontVariant: ['tabular-nums'] },
  spinner: { marginTop: 20 },

  pageRows: { marginTop: 8 },
  pageRow: { gap: 8, paddingVertical: 12, borderTopWidth: 1 },
  pageHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pageName: { flex: 1, fontSize: 14, fontWeight: '500' },
  pageTime: { fontSize: 16, fontWeight: '600' },
  pageFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  pageMeta: { fontSize: 12 },
  swatch: { width: 10, height: 10, borderRadius: 2 },

  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  meter: { gap: 8, marginTop: 16 },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  meterLabel: { flexShrink: 1, fontSize: 13 },
  meterValue: { fontSize: 15, fontWeight: '600' },

  readout: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, marginTop: 14 },
  readoutLabel: { fontSize: 13.5, fontWeight: '600' },
  readoutValue: { fontSize: 13 },
  // marginTop leaves room for the top axis label, which sits half above its gridline.
  plotRow: { flexDirection: 'row', marginTop: 18 },
  yAxis: { width: AXIS_W },
  yLabel: { position: 'absolute', right: 8 },
  plot: { flex: 1 },
  grid: { position: 'absolute', left: 0, right: 0, height: 1 },
  bars: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-end', gap: GAP },
  slot: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  bar: { width: '100%', maxWidth: BAR_MAX_W },
  // Rounded at the data end, square at the baseline.
  barEnd: { borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  xAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingLeft: AXIS_W },
  axisText: { fontSize: 10.5 },

  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  legendText: { fontSize: 12.5, fontWeight: '500' },
  legendValue: { fontSize: 12 },
  dim: { opacity: 0.35 },
});
