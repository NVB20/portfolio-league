// A small rounded label: up (gain), down (loss), warn (near the 20% cap) or ghost (neutral count/time).
// Inside an inverse card the fills change so the chip stays readable (DD-11).

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { fixed } from '../../theme';
import { usePalette } from './Card';

export type ChipVariant = 'up' | 'down' | 'warn' | 'ghost';

// `large`: the same height and type as a Button, for a status that sits in a row of buttons.
export function Chip({ variant = 'ghost', large = false, children }: { variant?: ChipVariant; large?: boolean; children: ReactNode }) {
  const { colors } = useTheme();
  const { tone } = usePalette();
  const inverse = tone === 'inverse';

  const look = {
    up: inverse ? [fixed.inverseAccent, fixed.inverseAccentInk] : [colors.accentTint, colors.accent],
    down: [colors.negTint, colors.neg],
    warn: inverse ? [fixed.warnFill, fixed.warnFillInk] : [colors.warnTint, colors.warn],
    ghost: inverse ? [colors.inverseTile, colors.inverseInk] : [colors.surface2, colors.muted],
  }[variant];

  return (
    <View style={[styles.chip, large && styles.large, { backgroundColor: look[0], borderColor: look[0] }]}>
      <Text style={[styles.text, large && styles.largeText, { color: look[1] }, variant === 'ghost' && styles.ghostText]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 9 },
  text: { fontSize: 11.5, fontWeight: '600' },
  ghostText: { fontWeight: '500' },
  // Mirrors Button's btn/label styles (1px border included) so the heights match exactly.
  large: { borderWidth: 1, paddingVertical: 11, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  largeText: { fontSize: 13.5 },
});
