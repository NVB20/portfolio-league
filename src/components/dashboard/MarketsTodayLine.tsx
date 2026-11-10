// On the days when only one market trades, one line under the top bar says so (D-022):
// "היום רק ניו יורק פתוחה · ת״א סגורה: פסח". A single "market open" light would be wrong for half the stocks.

import { StyleSheet, Text, View } from 'react-native';
import type { ClockView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { oneMarketToday } from '../../dashboard/markets';
import { FadeUp } from './motion';

export function MarketsTodayLine({ clock }: { clock: ClockView | null }) {
  const { colors } = useTheme();
  const line = clock ? oneMarketToday(clock.markets) : null;
  if (!line) return null;
  return (
    <FadeUp duration={500} style={styles.wrap}>
      <View style={[styles.line, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={[styles.dot, { backgroundColor: colors.warn }]} />
        <Text style={[styles.text, { color: colors.muted }]}>{line}</Text>
      </View>
    </FadeUp>
  );
}

const styles = StyleSheet.create({
  // flex-start: hugs its text on the right, where the Hebrew page starts.
  wrap: { alignSelf: 'flex-start', maxWidth: '100%', marginTop: 16 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingVertical: 7, paddingHorizontal: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: 12.5, flexShrink: 1 },
});
