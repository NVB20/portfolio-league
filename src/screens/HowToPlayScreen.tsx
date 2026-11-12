// The rules page (/how-to-play): every rule of the game on one scroll, opened from "איך משחקים" in the avatar menu.
// Seven sections, laid out like the other player pages (DD-02: a headline beside rows of cards, every other
// section on the other side). The copy is plain data in src/howToPlay/content.ts; the cards are RuleCards.tsx.
//
// The first section's headline has a jump link to each section below it. The URL can open the page on a section:
// /how-to-play?section=stability (the score card's "איך משפרים את היציבות ←"). It scrolls there once the sections
// are laid out.
//
// No data: the page doesn't call the API, so the top bar shows no clock, and no tab is on (it isn't a tab).

import { useCallback, useEffect, useRef } from 'react';
import { Animated, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import { useTheme } from '../useTheme';
import { PAGE_FOOTER, parseSection, SECTIONS, type SectionId } from '../howToPlay/content';
import { Button } from '../components/dashboard/Button';
import { CardRow } from '../components/dashboard/CardRow';
import { MAX_WIDTH } from '../components/dashboard/layout';
import { MotionProvider, OffsetProvider, useMeasure, useScrollMotion } from '../components/dashboard/motion';
import { Accent, Section } from '../components/dashboard/Section';
import { BAR_HEIGHT, TopBar } from '../components/dashboard/TopBar';
import { RuleCardView } from '../components/howToPlay/RuleCards';

const toTrade = () => router.navigate('/trade');
const JUMP_SETTLE_MS = 150;   // after the last section reports its place, time for the layout to settle

export default function HowToPlayScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ section?: string }>();
  const target = parseSection(params.section);
  const name = user?.displayName || user?.email?.split('@')[0] || 'שחקן';

  const { motion, onScroll } = useScrollMotion();
  const wrap = useMeasure(0);   // where the content starts inside the scroll (under the floating bar)
  const scroll = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);
  // Each section's top inside the content. The content starts BAR_HEIGHT down, under the floating bar, so
  // scrolling to a section's own y puts its top edge right under the bar.
  const tops = useRef<Partial<Record<SectionId, number>>>({});
  const pending = useRef<SectionId | null>(null);   // the section the URL asked for, until we've scrolled to it
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const animated = !motion.reduce;

  const scrollTo = useCallback(
    (id: SectionId, smooth: boolean) => {
      const y = tops.current[id];
      if (y === undefined) return false;
      scroll.current?.scrollTo({ y: Math.max(0, y), animated: smooth && animated });
      return true;
    },
    [animated],
  );

  // Every section's layout reports in one pass, and a later one moves when an earlier one grows, so wait for
  // the reports to stop before scrolling to the asked-for section.
  const jumpSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (pending.current && scrollTo(pending.current, false)) pending.current = null;
    }, JUMP_SETTLE_MS);
  }, [scrollTo]);

  useEffect(() => {
    pending.current = target;
    if (target) jumpSoon();
  }, [target, jumpSoon]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onSectionLayout = (id: SectionId) => (e: LayoutChangeEvent) => {
    tops.current[id] = e.nativeEvent.layout.y;
    if (pending.current) jumpSoon();
  };

  return (
    <MotionProvider value={motion}>
      <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
        <Animated.ScrollView ref={scroll as never} contentContainerStyle={styles.scroll} onScroll={onScroll} scrollEventThrottle={16}>
          <View style={styles.wrap} onLayout={wrap.onLayout}>
            <OffsetProvider value={wrap.abs}>
              {SECTIONS.map((s, i) => (
                <Section
                  key={s.id}
                  first={i === 0}
                  alt={i % 2 === 1}
                  eyebrow={s.eyebrow}
                  title={
                    <>
                      {`${s.lead}\n`}
                      <Accent>{s.accent}</Accent>
                    </>
                  }
                  body={s.body}
                  actions={i === 0 ? <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} /> : undefined}
                  after={i === 0 ? <JumpLinks onJump={(id) => scrollTo(id, true)} /> : undefined}
                  onLayout={onSectionLayout(s.id)}
                >
                  {s.rows.map((row, r) => (
                    <CardRow key={r}>
                      {row.map((card) => (
                        <RuleCardView key={card.title} card={card} />
                      ))}
                    </CardRow>
                  ))}
                </Section>
              ))}
            </OffsetProvider>
            <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>{PAGE_FOOTER}</Text>
          </View>
        </Animated.ScrollView>

        {/* Floating "new order" button, as on every player page: opens the trading screen. */}
        <View style={styles.fab} pointerEvents="box-none">
          <Button label="+ פקודה חדשה" variant="primary" onPress={toTrade} />
        </View>

        {/* Last, so it draws on top: the bar floats over the scrolling page. */}
        <TopBar clock={null} name={name} rankLine={null} active={null} />
      </View>
    </MotionProvider>
  );
}

// "בעמוד הזה": a small button for each section after the first.
function JumpLinks({ onJump }: { onJump: (id: SectionId) => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.jumps}>
      <Text style={[styles.jumpsLabel, { color: colors.faint }]}>בעמוד הזה</Text>
      <View style={styles.jumpRow}>
        {SECTIONS.slice(1).map((s) => (
          <Button key={s.id} label={s.chip} small onPress={() => onJump(s.id)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { paddingTop: BAR_HEIGHT, paddingBottom: 110 },   // room under the floating bar and above the floating button
  wrap: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16 },
  footer: { paddingTop: 32, borderTopWidth: 1, fontSize: 13 },
  fab: { position: 'absolute', bottom: 20, right: 16 },   // the right edge: where a Hebrew page starts
  jumps: { marginTop: 28, gap: 10 },
  jumpsLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  jumpRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
