// Small pieces the admin pages share (/admin-dashboard and /admin-monitoring), so a number, a tile row or a
// list line looks the same on both. Colors come from usePalette(), so each piece flips with an inverse card.

import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { usePalette } from '../dashboard/Card';

// One big figure with its unit beside it: "12 שחקנים".
export function BigNumber({ value, unit }: { value: string; unit: string }) {
  const p = usePalette();
  return (
    <View style={styles.big}>
      <Text style={[styles.bigValue, styles.num, { color: p.fg }]}>{value}</Text>
      <Text style={[styles.bigUnit, { color: p.sub }]}>{unit}</Text>
    </View>
  );
}

// A row of small figures. `solid` = the one tile in accent, the number the row leads to.
export function Tiles({ items }: { items: { value: string; label: string; solid?: boolean }[] }) {
  const { colors } = useTheme();
  const p = usePalette();
  return (
    <View style={styles.tiles}>
      {items.map((t) => (
        <View key={t.label} style={[styles.tile, { backgroundColor: t.solid ? colors.accent : p.tile }]}>
          <Text style={[styles.tileValue, styles.num, { color: t.solid ? colors.accentInk : p.fg }]}>{t.value}</Text>
          <Text style={[styles.tileLabel, { color: t.solid ? colors.accentInk : p.sub }, t.solid && { opacity: 0.75 }]}>{t.label}</Text>
        </View>
      ))}
    </View>
  );
}

// The box a list of Line rows sits in.
export function Lines({ children }: { children: ReactNode }) {
  return <View style={styles.lines}>{children}</View>;
}

// One line of a list: a status dot (optional), the label, and the value at the far end.
export function Line({ label, value, strong = false, warn = false }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  const p = usePalette();
  return (
    <View style={[styles.line, { borderTopColor: p.line }]}>
      <View style={[styles.dot, { backgroundColor: warn ? p.warn : p.accentFill }]} />
      <Text style={[styles.lineLabel, { color: p.fg }]}>{label}</Text>
      <Text style={[strong ? styles.lineStrong : styles.lineValue, styles.num, { color: strong ? p.fg : p.sub }]}>{value}</Text>
    </View>
  );
}

export function SubText({ children }: { children: string }) {
  const p = usePalette();
  return <Text style={[styles.subText, { color: p.sub }]}>{children}</Text>;
}

// The whole page while its first load runs, or after it failed: a spinner, or the error and a retry button.
// `children` is the page's top bar, so the way out stays on screen either way.
export function AdminFallback({ isLoading, error, onRetry, children }: {
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.page }]}>
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={[styles.error, { color: colors.fg }]}>{error ?? 'משהו השתבש'}</Text>
          <Pressable onPress={onRetry} style={[styles.retry, { borderColor: colors.accent }]} accessibilityRole="button">
            <Text style={{ color: colors.accent, fontWeight: '700' }}>נסו שוב</Text>
          </Pressable>
        </View>
      )}
      {children}
    </View>
  );
}

// The line under the last section of an admin page.
export function AdminFooter({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.footer, { color: colors.faint, borderTopColor: colors.line }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  error: { fontSize: 16 },
  retry: { borderWidth: 1.5, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24 },
  footer: { paddingTop: 32, borderTopWidth: 1, fontSize: 13 },
  num: { fontVariant: ['tabular-nums'] },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 12 },
  bigValue: { fontSize: 30, fontWeight: '500', letterSpacing: -0.5 },
  bigUnit: { fontSize: 13 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  tile: { flexGrow: 1, flexBasis: 120, borderRadius: 16, padding: 14 },
  tileValue: { fontSize: 24, fontWeight: '600' },
  tileLabel: { fontSize: 12, marginTop: 4 },
  lines: { marginTop: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  lineLabel: { fontSize: 13.5, flex: 1 },
  lineValue: { fontSize: 12.5 },
  lineStrong: { fontSize: 16, fontWeight: '600' },
  subText: { fontSize: 12.5, lineHeight: 19, marginTop: 10 },
});
