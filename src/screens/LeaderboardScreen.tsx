// The weekly leaderboard (/leaderboard, the "טבלה" tab), from docs/design/leaderboard. One scroll, two sections:
//   1. Your place: the headline, your place (inverse card), the podium, your past weeks, how the score is made
//   2. The full table: "ראש הטבלה / סביבי", the rows, "טען עוד 20"
//
// Data: GET /me/leaderboard (useLeaderboard). The board shown is the latest scored day up to today (D-032), so on
// the weekend and on Monday before the first open it is the closed week, marked "השבוע נסגר". The API only reads
// places; the runner's scoring step writes them at every open and close (D-034, api/src/scoring.ts).
// `npm run seed:sample-board` can still fill a local board for development (D-033).
// "לשורה שלי" switches the table to the places around you and scrolls to your row once it is laid out.

import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { LeaderboardView, LiveClockView } from '../../api/src/contract';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { boardEyebrow, boardFooter, count, gameEnded, headline, isoWeek, rankLine, tableHeadline, type TableView } from '../leaderboard/board';
import { useLeaderboard, type MoreState } from '../leaderboard/useLeaderboard';
import { Button } from '../components/dashboard/Button';
import { CardRow } from '../components/dashboard/CardRow';
import { Chip } from '../components/dashboard/Chip';
import { ScoreBreakdownCard } from '../components/dashboard/CompetitionCards';
import { MAX_WIDTH } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { Accent, Section } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { LeaderboardTable } from '../components/leaderboard/LeaderboardTable';
import { PastWeeksCard } from '../components/leaderboard/PastWeeksCard';
import { PodiumCard } from '../components/leaderboard/PodiumCard';
import { Segmented } from '../components/leaderboard/Segmented';
import { TableSection } from '../components/leaderboard/TableSection';
import { YourPlaceCard } from '../components/leaderboard/YourPlaceCard';

const toTrade = () => router.navigate('/trade');
const JUMP_SETTLE_MS = 150;   // after the "around" rows land, time for them to lay out before scrolling to yours

export default function LeaderboardScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const lb = useLeaderboard();
  // The player's own name, for their own menu. (Rows use the name saved by the API.)
  const name = user?.displayName || user?.email?.split('@')[0] || 'שחקן';

  if (lb.data) {
    return (
      <LeaderboardPage
        board={lb.data}
        clock={lb.clock}
        name={name}
        view={lb.view}
        setView={lb.setView}
        loading={lb.isLoading}
        error={lb.error}
        reload={lb.reload}
        more={lb.more}
        loadMore={lb.loadMore}
      />
    );
  }

  return (
    // direction: 'rtl' = Hebrew layout: rows start on the right.
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
      <View style={styles.center}>
        {lb.isLoading ? (
          <ActivityIndicator size="large" color={colors.accent} />
        ) : (
          <>
            <Text style={[styles.error, { color: colors.fg }]}>{lb.error ?? 'משהו השתבש'}</Text>
            <Pressable onPress={lb.reload} style={[styles.retry, { borderColor: colors.accent }]} accessibilityRole="button">
              <Text style={{ color: colors.accent, fontWeight: '700' }}>נסו שוב</Text>
            </Pressable>
          </>
        )}
      </View>
      <TopBar clock={lb.clock} name={name} rankLine={null} active="leaderboard" />
    </View>
  );
}

type PageProps = {
  board: LeaderboardView;
  clock: LiveClockView | null;
  name: string;
  view: TableView;
  setView: (v: TableView) => void;
  loading: boolean;
  error: string | null;   // the last reload or view switch failed: the board shown is the one before it
  reload: () => void;
  more: MoreState;
  loadMore: () => void;
};

function LeaderboardPage({ board, clock, name, view, setView, loading, error, reload, more, loadMore }: PageProps) {
  const { colors } = useTheme();
  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);   // where the content starts inside the scroll (under the floating bar)
  const scroll = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);
  const tableTop = useRef<number | null>(null);
  const meTop = useRef<number | null>(null);
  const wantJump = useRef(false);   // "לשורה שלי" was pressed; scroll once your row is laid out
  const loadingNow = useRef(loading);
  useEffect(() => {
    loadingNow.current = loading;
  }, [loading]);
  // The "around" rows never came: don't scroll later, when some other layout change moves your row.
  useEffect(() => {
    if (error) wantJump.current = false;
  }, [error]);

  const animated = !motion.reduce;
  const viewport = motion.viewport;
  const scrollToY = useCallback(
    (y: number) => scroll.current?.scrollTo({ y: Math.max(0, y), animated }),
    [animated],
  );
  // Your row a third of the way down the screen, under the bar, with rows above it in view.
  const scrollToRow = useCallback((y: number) => scrollToY(y - BAR_HEIGHT - viewport * 0.3), [scrollToY, viewport]);

  const onMeAt = useCallback(
    (y: number) => {
      meTop.current = y;
      if (wantJump.current && !loadingNow.current) {
        wantJump.current = false;
        scrollToRow(y);
      }
    },
    [scrollToRow],
  );
  const onTableTop = useCallback((y: number) => {
    tableTop.current = y;
  }, []);

  // The "around" rows have landed but your row's position didn't change (so it didn't report again): scroll to
  // where it is once layout has settled.
  useEffect(() => {
    if (loading || !wantJump.current || board.view !== 'around') return;
    const t = setTimeout(() => {
      if (wantJump.current && meTop.current !== null) {
        wantJump.current = false;
        scrollToRow(meTop.current);
      }
    }, JUMP_SETTLE_MS);
    return () => clearTimeout(t);
  }, [board, loading, scrollToRow]);

  const toMyRow = () => {
    if (view === 'around' && !loading && meTop.current !== null) {
      scrollToRow(meTop.current);
      return;
    }
    wantJump.current = true;
    setView('around');
  };
  const toTable = () => {
    if (tableTop.current !== null) scrollToY(tableTop.current - BAR_HEIGHT);
  };

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView ref={scroll as never} contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              <YourPlaceSection board={board} onMyRow={toMyRow} onTable={toTable} />
              <TableSection
                eyebrow="הטבלה המלאה"
                title={<TableTitle board={board} />}
                body="לכל שחקן: ציון, תשואה שבועית, ירידה מקסימלית ושני הדירוגים שמרכיבים את הציון."
                onTop={onTableTop}
                toolbar={
                  <>
                    <Segmented
                      label="תצוגת הטבלה"
                      // Not on the board: the API answers 'around' with the top rows (view: 'top'), so show that.
                      value={board.me ? view : 'top'}
                      onChange={setView}
                      options={[
                        { value: 'top', label: 'ראש הטבלה' },
                        {
                          value: 'around',
                          label: 'סביבי',
                          disabled: !board.me,
                          hint: board.me ? 'חמישה מקומות מעליך וחמישה מתחתיך' : 'זמין כשאתה בדירוג השבוע',
                        },
                      ]}
                    />
                    {board.week?.final ? <Chip large>השבוע נסגר</Chip> : null}
                  </>
                }
              >
                {error && !loading ? <ReloadError text={error} onRetry={reload} /> : null}
                <LeaderboardTable board={board} loading={loading} more={more} onMore={loadMore} onMeAt={onMeAt} />
              </TableSection>
            </OffsetProvider>
            <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>
              {boardFooter(gameEnded(board.week, board.clock))}
            </Text>
          </View>
        </Animated.ScrollView>

        {/* Floating "new order" button: opens the trading screen. */}
        <View style={styles.fab} pointerEvents="box-none">
          <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} />
        </View>

        {/* Last, so it draws on top: the bar floats over the scrolling page. */}
        {/* The week of the board shown, not the clock's: on Monday before the open they differ (D-032). */}
        <TopBar
          clock={clock}
          name={name}
          rankLine={rankLine(board.me?.rank ?? null, board.week ? isoWeek(board.week.start) : null)}
          active="leaderboard"
        />
      </View>
    </MotionProvider>
  );
}

// Section 1: the headline and the cards about you.
function YourPlaceSection({ board, onMyRow, onTable }: { board: LeaderboardView; onMyRow: () => void; onTable: () => void }) {
  const h = headline(board);
  return (
    <Section
      first
      eyebrow={boardEyebrow(board.week, true, gameEnded(board.week, board.clock))}
      title={
        h.place ? (
          <>
            {'מקום '}
            <Accent>{String(h.place.rank)}</Accent>
            {` מתוך ${count(h.place.players)}.\n`}
            <Accent>{h.accent}</Accent>
          </>
        ) : (
          <>
            {`${h.lead}\n`}
            <Accent>{h.accent}</Accent>
          </>
        )
      }
      body="הציון משווה אותך לכל השחקנים השבוע: 85% לפי דירוג התשואה ו־15% לפי דירוג היציבות. שינוי קטן בתשואה מזיז הרבה מקומות, כי הדירוג הוא אחוזון."
      actions={
        <>
          <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} />
          <Button label="לטבלה המלאה ↓" onPress={onTable} />
        </>
      }
    >
      <CardRow>
        <YourPlaceCard board={board} onMyRow={onMyRow} />
        <PodiumCard board={board} />
      </CardRow>
      <CardRow>
        {board.pastWeeks.length > 0 ? <PastWeeksCard board={board} /> : null}
        <ScoreBreakdownCard standing={board.me} />
      </CardRow>
    </Section>
  );
}

// A reload or a view switch failed while a board is on screen: say so over the table (the rows are the last good
// ones), with a retry.
function ReloadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="alert" style={[styles.reloadError, { borderColor: colors.neg }]}>
      <Text style={[styles.reloadText, { color: colors.neg }]}>{`${text}. מוצגת הטבלה האחרונה שנטענה.`}</Text>
      <Button label="נסו שוב" small onPress={onRetry} />
    </View>
  );
}

// Section 2's headline: "1,284 שחקנים. אתה ב־1% העליון."
function TableTitle({ board }: { board: LeaderboardView }) {
  const t = tableHeadline(board);
  return (
    <>
      {t.lead}
      {t.accent ? (
        <>
          {' '}
          <Accent>{t.accent}</Accent>
        </>
      ) : null}
    </>
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
