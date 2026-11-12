// The leaderboard's second section (LD-01): the headline and the toolbar ABOVE one full-width card, instead of the
// dashboard's 5/7 split, because a nine-column table needs the whole width. The headline reveals on scroll like
// the dashboard's (DD-06); the table itself doesn't move.

import { ReactNode, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { useLayout } from '../dashboard/layout';
import { OffsetProvider, ScrollReveal, useMeasure } from '../dashboard/motion';

type Props = {
  eyebrow: string;
  title: ReactNode;
  body?: string;
  toolbar?: ReactNode;
  onTop?: (y: number) => void;   // where the section starts inside the scroll, for "to the table" buttons
  first?: boolean;               // the page's first section (/admin-users): no divider above it, as Section's `first`
  children: ReactNode;
};

export function TableSection({ eyebrow, title, body, toolbar, onTop, first = false, children }: Props) {
  const { colors } = useTheme();
  const { width } = useLayout();
  const size = Math.round(Math.min(44, Math.max(28, width * 0.034)));   // clamp(28px, 3.4vw, 44px), the mock-up's h2
  const stage = useMeasure();
  const head = useMeasure(stage.abs);

  useEffect(() => {
    if (stage.measured) onTop?.(stage.abs);
  }, [onTop, stage.abs, stage.measured]);

  return (
    <View onLayout={stage.onLayout} style={[styles.stage, { borderTopColor: colors.line, borderTopWidth: first ? 0 : 1 }]}>
      <View onLayout={head.onLayout}>
        <ScrollReveal abs={head.abs} h={head.h} measured={head.measured}>
          <View style={styles.head}>
            <View style={styles.copy}>
              <Text style={[styles.eyebrow, { color: colors.accent }]}>{eyebrow}</Text>
              <Text style={[styles.title, { color: colors.fg, fontSize: size, lineHeight: size * 1.12 }]}>{title}</Text>
              {body ? <Text style={[styles.body, { color: colors.muted }]}>{body}</Text> : null}
            </View>
            {toolbar ? <View style={styles.toolbar}>{toolbar}</View> : null}
          </View>
        </ScrollReveal>
      </View>
      <OffsetProvider value={stage.abs}>{children}</OffsetProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { borderTopWidth: 1, paddingTop: 56, paddingBottom: 32, gap: 24 },
  head: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 },
  copy: { maxWidth: 560, flexShrink: 1 },
  eyebrow: { fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 14 },
  title: { fontWeight: '300', letterSpacing: -0.4 },
  body: { fontSize: 15, lineHeight: 22, marginTop: 12, maxWidth: 440 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
});
