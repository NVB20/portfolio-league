// The trade journal (/journal, the "יומן" tab, D-035). One scroll, two sections, like the leaderboard:
//   1. Summary: the headline (how many sells made money, the realized gain), the week / whole-game switch, the
//      success rate (inverse card) and the results (four tiles)
//   2. Every order: the filter (all / waiting / filled / rejected) over one full-width table, "טען עוד 20"
//
// Data: GET /me/journal (useJournal). The URL can open it on a filter: /journal?filter=pending (the dashboard's and
// the trading screen's pending orders link here). A row opens its stock on the trading screen.

import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { TradeJournalFilter, TradeJournalPeriod, TradeJournalView } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { filterLabel, headline, parseFilter, tableHeadline } from '../journal/journal';
import { useJournal, type MoreState } from '../journal/useJournal';
import { Button } from '../components/dashboard/Button';
import { CardRow } from '../components/dashboard/CardRow';
import { MAX_WIDTH } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { Accent, Section } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { ResultsCard, SuccessCard } from '../components/journal/JournalCards';
import { JournalTable } from '../components/journal/JournalTable';
import { Segmented } from '../components/leaderboard/Segmented';
import { TableSection } from '../components/leaderboard/TableSection';

const toTrade = () => router.navigate('/trade');
const FILTERS: TradeJournalFilter[] = ['all', 'pending', 'executed', 'rejected'];

export default function JournalScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ filter?: string }>();
  const j = useJournal(parseFilter(params.filter));
  const name = user?.displayName || user?.email?.split('@')[0] || 'שחקן';

  if (j.data) {
    return (
      <JournalPage
        journal={j.data}
        name={name}
        filter={j.filter}
        setFilter={j.setFilter}
        period={j.period}
        setPeriod={j.setPeriod}
        loading={j.isLoading}
        error={j.error}
        reload={j.reload}
        more={j.more}
        loadMore={j.loadMore}
      />
    );
  }

  return (
    // direction: 'rtl' = Hebrew layout: rows start on the right.
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
      <View style={styles.center}>
        {j.isLoading ? (
          <ActivityIndicator size="large" color={colors.accent} />
        ) : (
          <>
            <Text style={[styles.error, { color: colors.fg }]}>{j.error ?? 'משהו השתבש'}</Text>
            <Pressable onPress={j.reload} style={[styles.retry, { borderColor: colors.accent }]} accessibilityRole="button">
              <Text style={{ color: colors.accent, fontWeight: '700' }}>נסו שוב</Text>
            </Pressable>
          </>
        )}
      </View>
      <TopBar clock={j.clock} name={name} rankLine={null} active="journal" />
    </View>
  );
}

type PageProps = {
  journal: TradeJournalView;
  name: string;
  filter: TradeJournalFilter;
  setFilter: (f: TradeJournalFilter) => void;
  period: TradeJournalPeriod;
  setPeriod: (p: TradeJournalPeriod) => void;
  loading: boolean;
  error: string | null;   // the last reload or switch failed: the journal shown is the one before it
  reload: () => void;
  more: MoreState;
  loadMore: () => void;
};

function JournalPage({ journal, name, filter, setFilter, period, setPeriod, loading, error, reload, more, loadMore }: PageProps) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);   // where the content starts inside the scroll (under the floating bar)
  const h = headline(journal);
  const t = tableHeadline(journal);

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <Section
                first
                eyebrow="יומן המסחר"
                title={
                  <>
                    {`${h.lead}\n`}
                    <Accent>{h.accent}</Accent>
                  </>
                }
                body="כל פקודה ששלחת ומה קרה לה. מכירה ברווח היא הצלחה, מכירה בהפסד היא כישלון. קנייה נספרת רק כשמוכרים אותה."
                actions={
                  <>
                    <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} />
                    <Segmented
                      label="התקופה ביומן"
                      value={period}
                      onChange={setPeriod}
                      options={[
                        { value: 'all', label: 'מתחילת המשחק', hint: 'כל הפקודות ששלחת' },
                        { value: 'week', label: 'השבוע', hint: 'רק פקודות שרצו או ירוצו השבוע' },
                      ]}
                    />
                  </>
                }
              >
                <CardRow>
                  <SuccessCard journal={journal} />
                  <ResultsCard journal={journal} />
                </CardRow>
              </Section>

              <TableSection
                eyebrow="כל הפקודות"
                title={
                  <>
                    {t.lead}
                    {t.accent ? (
                      <>
                        {' '}
                        <Accent>{t.accent}</Accent>
                      </>
                    ) : null}
                  </>
                }
                body="פקודה שנשלחה לא ניתנת לביטול. לחיצה על שורה פותחת את המניה במסך המסחר."
                toolbar={
                  <Segmented
                    label="סינון הפקודות"
                    value={filter}
                    onChange={setFilter}
                    options={FILTERS.map((f) => ({ value: f, label: filterLabel(f, journal.counts) }))}
                  />
                }
              >
                {error && !loading ? <ReloadError text={error} onRetry={reload} /> : null}
                <JournalTable journal={journal} loading={loading} more={more} onMore={loadMore} onStopMoved={reload} />
              </TableSection>
            </OffsetProvider>
            <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>
              כל השחקנים חיים באותו שעון. פקודה רצה בשער הסגירה של היום אם נשלחה בזמן המסחר, אחרת בשער הפתיחה הבא.
            </Text>
          </View>
        </Animated.ScrollView>

        {/* Floating "new order" button: opens the trading screen. */}
        <View style={styles.fab} pointerEvents="box-none">
          <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} />
        </View>

        {/* Last, so it draws on top: the bar floats over the scrolling page. */}
        <TopBar clock={journal.clock} name={name} rankLine={null} active="journal" />
      </View>
    </MotionProvider>
  );
}

// A reload or a switch failed while a journal is on screen: say so over the table, with a retry.
function ReloadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="alert" style={[styles.reloadError, { borderColor: colors.neg }]}>
      <Text style={[styles.reloadText, { color: colors.neg }]}>{`${text}. מוצג היומן האחרון שנטען.`}</Text>
      <Button label="נסו שוב" small onPress={onRetry} />
    </View>
  );
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
  reloadError: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  reloadText: { fontSize: 13.5, fontWeight: '600', flexShrink: 1 },
});
