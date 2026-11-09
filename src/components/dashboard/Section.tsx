// One of the three scrolling sections (DD-02): a big headline column and a group of cards.
// Desktop: headline on one side (sticky on web), cards on the other; `alt` swaps the sides.
// Phone/tablet: headline on top, cards below.
//
// Motion (DD-06):
//   first section  plays the load sequence: headline, then each row at a set delay
//   other sections the headline and each row rise in as they scroll into view
//   all sections   desktop: the card group drifts against the sticky headline;
//                  the gaps between rows widen with scroll speed

import { Children, ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { useLayout, webSticky } from './layout';
import { FadeUp, OffsetProvider, ScrollReveal, SeenContext, Spread, useDrift, useMeasure, useSeen } from './motion';

// Section 1's load sequence, ms after the page appears (headline at 0). Done by ~2.2s with the gauge.
const BOOT_ROW_DELAYS = [200, 400, 600];

type Props = {
  eyebrow: string;
  title: ReactNode;      // the headline; nest <Accent> / <Strong> inside for the highlighted words
  body?: ReactNode;      // a sentence, or any content (the trading screen puts the price row here)
  actions?: ReactNode;
  alt?: boolean;
  first?: boolean;       // the first section: no divider above, and it plays the load sequence
  children: ReactNode;   // the cards, one CardRow per child
};

export function Section({ eyebrow, title, body, actions, alt = false, first = false, children }: Props) {
  const { colors } = useTheme();
  const { isWide, gap, headlineSize } = useLayout();
  const stage = useMeasure();
  // The headline and the card group sit inside the stage, which is measured right here.
  const copyBox = useMeasure(stage.abs);
  const cluster = useMeasure(stage.abs);
  const drift = useDrift(isWide, cluster.abs, cluster.h);
  const rows = Children.toArray(children);

  const headline = (
    <>
      <Text style={[styles.eyebrow, { color: colors.accent }]}>{eyebrow}</Text>
      <Text style={[styles.title, { color: colors.fg, fontSize: headlineSize, lineHeight: headlineSize * 1.12 }]}>{title}</Text>
      {typeof body === 'string' ? <Text style={[styles.body, { color: colors.muted }]}>{body}</Text> : body ?? null}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </>
  );

  const copy = (
    <View key="copy" onLayout={copyBox.onLayout} style={isWide ? [styles.copyWide, webSticky(100)] : undefined}>
      {first ? (
        <FadeUp duration={500}>{headline}</FadeUp>
      ) : (
        <ScrollReveal abs={copyBox.abs} h={copyBox.h} measured={copyBox.measured}>
          {headline}
        </ScrollReveal>
      )}
    </View>
  );

  const cards = (
    <Animated.View key="cards" onLayout={cluster.onLayout} style={[{ gap }, isWide && styles.cardsWide, drift]}>
      <OffsetProvider value={cluster.abs}>
        {rows.map((row, i) => (
          <SectionRow key={i} index={i} count={rows.length} boot={first}>
            {row}
          </SectionRow>
        ))}
      </OffsetProvider>
    </Animated.View>
  );

  return (
    <View
      onLayout={stage.onLayout}
      style={[styles.stage, { borderTopColor: colors.line, borderTopWidth: first ? 0 : 1 }, isWide ? styles.stageWide : null]}
    >
      {isWide && alt ? [cards, copy] : [copy, cards]}
    </View>
  );
}

// One row of cards. Knows where it is in the page, so it can reveal on scroll and tell its cards when
// they've been seen (the weight bars wait for that). Its offset for the gap spread is centred on 0.
function SectionRow({ index, count, boot, children }: { index: number; count: number; boot: boolean; children: ReactNode }) {
  const box = useMeasure();
  const seen = useSeen(box.abs, box.h, box.measured);
  return (
    <Spread offset={index - (count - 1) / 2} onLayout={box.onLayout}>
      <OffsetProvider value={box.abs}>
        <SeenContext.Provider value={seen}>
          {boot ? (
            <FadeUp delay={BOOT_ROW_DELAYS[index] ?? BOOT_ROW_DELAYS[BOOT_ROW_DELAYS.length - 1]}>{children}</FadeUp>
          ) : (
            <ScrollReveal abs={box.abs} h={box.h} measured={box.measured}>
              {children}
            </ScrollReveal>
          )}
        </SeenContext.Provider>
      </OffsetProvider>
    </Spread>
  );
}

// Words in the headline: <Accent> is the colored part, <Strong> the bold part, <Faint> the agorot.
export function Accent({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.accent, fontWeight: '600' }}>{children}</Text>;
}
export function Strong({ children }: { children: ReactNode }) {
  return <Text style={{ fontWeight: '600' }}>{children}</Text>;
}
export function Faint({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.faint, fontWeight: '300' }}>{children}</Text>;
}

const styles = StyleSheet.create({
  stage: { paddingVertical: 56, gap: 28 },
  // alignItems flex-start: the headline column must not stretch, or sticky has no room to move.
  stageWide: { flexDirection: 'row', paddingVertical: 80, gap: 56, alignItems: 'flex-start' },
  copyWide: { flex: 5 },
  cardsWide: { flex: 7 },
  eyebrow: { fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 14 },
  title: { fontWeight: '300', letterSpacing: -0.5 },
  body: { fontSize: 16, lineHeight: 24, marginTop: 18, maxWidth: 420 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 24 },
});
