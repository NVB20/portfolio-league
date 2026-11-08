// The small round "↗ open" button in a card's corner. It will open the card's full screen
// (chart, dollar rate, leaderboard); until those screens exist it's shown disabled.

import { Pressable, StyleSheet, Text } from 'react-native';
import { usePalette } from './Card';
import { useTheme } from '../../useTheme';

export function IconButton({ label, onPress }: { label: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const p = usePalette();
  const inverse = p.tone === 'inverse';
  const disabled = !onPress;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[
        styles.btn,
        inverse
          ? { backgroundColor: colors.inverseTile, borderColor: colors.inverseLine }
          : { backgroundColor: colors.surface2, borderColor: colors.line2 },
        disabled && { opacity: 0.55 },
      ]}
    >
      <Text style={[styles.icon, { color: inverse ? colors.inverseInk : colors.muted }]}>↗</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 13 },
});
