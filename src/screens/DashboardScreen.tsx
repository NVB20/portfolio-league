// The player's main screen (docs/design/dashboard). One long scroll with three sections:
//   1. Portfolio: value, chart vs. the median, weekly score, pending orders, world clock, dollar rate
//   2. Holdings: one card per security with its weight against the 20% cap
//   3. Competition: leaderboard, score breakdown, streak
// All data comes from one request (GET /me/dashboard). Empty world = every card says what will fill it.

import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Dashboard } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { useDashboard } from '../dashboard/useDashboard';
import { splitIls } from '../dashboard/format';
import { holdingsSummary, nearCapLine, portfolioSummary, standingLine, standingSummary } from '../dashboard/copy';
import { Button } from '../components/dashboard/Button';
import { Card, Empty } from '../components/dashboard/Card';
import { CardRow, CardStack } from '../components/dashboard/CardRow';
import { LeaderboardCard, ScoreBreakdownCard, StreakCard } from '../components/dashboard/CompetitionCards';
import { HoldingCard } from '../components/dashboard/HoldingCard';
import { MAX_WIDTH } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion, useTween } from '../components/dashboard/motion';
import { PendingOrdersCard } from '../components/dashboard/PendingOrdersCard';
import { PortfolioChartCard } from '../components/dashboard/PortfolioChart';
import { ScoreCard } from '../components/dashboard/ScoreCard';
import { Accent, Faint, Section, Strong } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { UsdRateCard } from '../components/dashboard/UsdRateCard';
import { WorldClockCard } from '../components/dashboard/WorldClockCard';

const NOT_BUILT = 'יחובר כשמסך הפקודות ייבנה';
const STARTING_CASH = 1_000_000;

export default function DashboardScreen() {
  const { colors } = useTheme();
  const { user, roles } = useAuth();
  const { data, error, isLoading, reload } = useDashboard();

  // The player's own name, for their own menu. (The leaderboard uses the name saved by the API.)
  const name = user?.displayName || user?.email?.split('@')[0] || 'שחקן';
  const rankLine = data?.standing
    ? `מקום #${data.standing.rank}${data.clock ? ` · שבוע ${data.clock.week}` : ''}`
    : null;

  if (data) return <DashboardView data={data} isAdmin={roles.includes('admin')} name={name} rankLine={rankLine} />;

  return (
    // direction: 'rtl' = Hebrew layout: rows start on the right.
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={[styles.error, { color: colors.fg }]}>{error ?? 'משהו השתבש'}</Text>
          <Pressable onPress={reload} style={[styles.retry, { borderColor: colors.accent }]} accessibilityRole="button">
            <Text style={{ color: colors.accent, fontWeight: '700' }}>נסו שוב</Text>
          </Pressable>
        </View>
      )}

      <TopBar clock={null} name={name} rankLine={null} />
    </View>
  );
}

// The page itself, from data. Separate from the loading/error states so it can be shown with any data.
export function DashboardView({ data, isAdmin, name, rankLine }: { data: Dashboard; isAdmin: boolean; name: string; rankLine: string | null }) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  // Where the content starts inside the scroll (under the floating bar): the base for every scroll effect.
  const wrap = useMeasure(0);

  return (
    <MotionProvider value={motion}>
      {/* direction: 'rtl' = Hebrew layout: rows start on the right. */}
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <Content d={data} isAdmin={isAdmin} />
            </OffsetProvider>
            <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>
              שעון העולם · כל השחקנים חיים באותו שעון. תל אביב: 10:00–17:30 (יום ו׳ עד 13:50). ניו יורק: 9:30–16:00 לפי שעון ניו יורק.
            </Text>
          </View>
        </Animated.ScrollView>

        {/* Floating "new order" button: shown where the design has it, enabled once the order form exists. */}
        <View style={styles.fab} pointerEvents="box-none">
          <Button label="+ פקודה חדשה" variant="primary" disabled hint={NOT_BUILT} />
        </View>

        {/* Last, so it draws on top: the bar floats over the scrolling page. */}
        <TopBar clock={data.clock} name={name} rankLine={rankLine} />
      </View>
    </MotionProvider>
  );
}

function Content({ d, isAdmin }: { d: Dashboard; isAdmin: boolean }) {
  // The headline counts up from the starting ₪1,000,000 to today's value over 1.4s (DD-06 load sequence).
  const count = useTween({ duration: 1400 });
  const value = splitIls(STARTING_CASH + (d.portfolio.totalValue - STARTING_CASH) * count);
  const today = d.clock?.date ?? null;

  return (
    <>
      {/* 1. Portfolio */}
      <Section
        first
        eyebrow={d.clock ? `שבוע ${d.clock.week} · ליגת תיקים` : 'ליגת תיקים'}
        title={
          <>
            {'התיק שלך שווה\n'}
            <Accent>{`₪${value.whole}`}</Accent>
            <Faint>{value.agorot}</Faint>
          </>
        }
        body={portfolioSummary(d)}
        actions={
          <>
            <Button label="+ פקודה חדשה" variant="primary" disabled hint={NOT_BUILT} />
            <Button label="לטבלת השבוע" disabled hint="יחובר כשמסך הטבלה ייבנה" />
          </>
        }
      >
        <CardRow>
          <PortfolioChartCard portfolio={d.portfolio} weekStartAt={d.clock?.weekStartAt ?? null} nowAt={d.clock?.at ?? null} />
        </CardRow>
        <CardRow>
          <ScoreCard standing={d.standing} todayWeekday={d.clock?.weekday ?? null} />
          <CardStack
            top={<PendingOrdersCard orders={d.pendingOrders} today={today} />}
            bottom={<WorldClockCard clock={d.clock} isAdmin={isAdmin} />}
          />
        </CardRow>
        <CardRow>
          <UsdRateCard usd={d.usdIls} />
        </CardRow>
      </Section>

      {/* 2. Holdings */}
      <Section
        alt
        eyebrow="האחזקות שלי"
        title={
          d.holdings.length === 0 ? (
            <>
              {'אין לך עדיין ניירות.\n'}
              <Accent>{nearCapLine(d.holdings)}</Accent>
            </>
          ) : (
            <>
              <Strong>{String(d.holdings.length)}</Strong>
              {d.holdings.length === 1 ? ' נייר.\n' : ' ניירות.\n'}
              <Accent>{nearCapLine(d.holdings)}</Accent>
            </>
          )
        }
        body={holdingsSummary(d.holdings)}
        actions={<Button label="כל 20 הניירות בעולם" disabled hint="יחובר כשמסך המסחר ייבנה" />}
      >
        {d.holdings.length === 0 ? (
          <CardRow>
            <Card title="אין אחזקות" sub="כל נייר שתקנה יקבל כאן כרטיס משלו">
              <Empty>כל נייר מוגבל ל־20% מהתיק ברגע הקנייה. הפס בכל כרטיס מראה כמה קרוב הנייר לתקרה.</Empty>
            </Card>
          </CardRow>
        ) : (
          pairs(d.holdings).map((pair) => (
            <CardRow key={pair.map((h) => h.symbol).join('-')}>
              {pair.map((h) => (
                <HoldingCard key={h.symbol} holding={h} />
              ))}
            </CardRow>
          ))
        )}
      </Section>

      {/* 3. Competition */}
      <Section
        eyebrow="טבלת השבוע · נסגרת יום ו׳ 13:50"
        title={
          d.standing ? (
            <>
              {'מקום '}
              <Accent>{String(d.standing.rank)}</Accent>
              {`.\n${standingLine(d.standing)}`}
            </>
          ) : (
            <>
              {'הטבלה עוד לא נפתחה.\n'}
              <Accent>הציון הראשון בסוף היום.</Accent>
            </>
          )
        }
        body={standingSummary(d)}
        actions={<Button label="לטבלה המלאה" disabled hint="יחובר כשמסך הטבלה ייבנה" />}
      >
        <CardRow>
          <LeaderboardCard leaderboard={d.leaderboard} standing={d.standing} />
          <ScoreBreakdownCard standing={d.standing} />
        </CardRow>
        <CardRow>
          <StreakCard />
        </CardRow>
      </Section>
    </>
  );
}

// Holdings sit two per row (DD-03).
function pairs<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  return out;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 110 },   // room under the floating bar and above the floating button
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  footer: { paddingTop: 32, borderTopWidth: 1, fontSize: 13 },
  fab: { position: 'absolute', bottom: 20, right: 16 },   // the right edge: where a Hebrew page starts
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  error: { fontSize: 16 },
  retry: { borderWidth: 1.5, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24 },
});
