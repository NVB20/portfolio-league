// primary (accent fill), outline, and ink (dark fill inside an inverse card).
// `disabled` is used for actions whose screen isn't built yet (order form, full leaderboard).

import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../../useTheme';

type Props = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline' | 'ink';
  small?: boolean;
  disabled?: boolean;
  hint?: string;   // accessibility hint, e.g. why it's disabled
};

export function Button({ label, onPress, variant = 'outline', small = false, disabled = false, hint }: Props) {
  const { colors } = useTheme();
  const look = {
    primary: { bg: colors.accent, border: colors.accent, fg: colors.accentInk },
    outline: { bg: 'transparent', border: colors.line2, fg: colors.fg },
    ink: { bg: colors.inverseInk, border: colors.inverseInk, fg: colors.inverse },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={hint}
      style={({ pressed }) => [
        styles.btn,
        small && styles.small,
        { backgroundColor: look.bg, borderColor: look.border },
        (disabled || pressed) && { opacity: disabled ? 0.45 : 0.85 },
      ]}
    >
      <Text style={[styles.label, small && styles.smallLabel, { color: look.fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { borderWidth: 1, borderRadius: 999, paddingVertical: 11, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  small: { paddingVertical: 7, paddingHorizontal: 12 },
  label: { fontSize: 13.5, fontWeight: '600' },
  smallLabel: { fontSize: 12.5 },
});
