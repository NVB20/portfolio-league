// The buttons of a walkthrough. All at least 44px tall. The primary button can carry the "next" arrow, which
// points left because the app reads right to left.

import { Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../useTheme';

type PrimaryProps = {
  label: string;
  onPress: () => void;
  height?: number;
  fontSize?: number;
  radius?: number;
  arrow?: boolean;
  grow?: boolean;       // fill the row (next to a back button)
};

export function PrimaryButton({ label, onPress, height = 54, fontSize = 17, radius = 14, arrow = false, grow = false }: PrimaryProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.primary,
        grow && styles.grow,
        { height, borderRadius: radius, backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[styles.primaryText, { fontSize, color: colors.accentInk }]}>{label}</Text>
      {arrow ? <Ionicons name="arrow-back" size={Math.round(fontSize * 1.05)} color={colors.accentInk} /> : null}
    </Pressable>
  );
}

type OutlineProps = { label: string; onPress: () => void; height?: number };

// A quiet button with an outline: "back", or the second choice on the last step.
export function OutlineButton({ label, onPress, height = 54 }: OutlineProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.outline,
        { height, borderColor: colors.line2, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.outlineText, { color: colors.fg }]}>{label}</Text>
    </Pressable>
  );
}

// A text-only link: "skip", "back" (admin), "show from the start". 44px tall touch target.
export function TextLink({ label, onPress, color, fontSize = 14, weight = '400', center = false, accessibilityLabel }: {
  label: string;
  onPress: () => void;
  color: string;
  fontSize?: number;
  weight?: '400' | '500' | '600';
  center?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.link, center && styles.linkCenter, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ fontSize, color, fontWeight: weight }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  grow: { flex: 1 },
  primaryText: { fontWeight: '600' },
  outline: { borderWidth: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  outlineText: { fontSize: 16, fontWeight: '500' },
  link: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  linkCenter: { alignItems: 'center' },
});
