// A small rounded label: up (gain), down (loss), warn (near the 20% cap) or ghost (neutral count/time).
// Inside an inverse card the fills change so the chip stays readable (DD-11).

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { fixed } from '../../theme';
import { usePalette } from './Card';

export type ChipVariant = 'up' | 'down' | 'warn' | 'ghost';

export function Chip({ variant = 'ghost', children }: { variant?: ChipVariant; children: ReactNode }) {
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
    <View style={[styles.chip, { backgroundColor: look[0] }]}>
      <Text style={[styles.text, { color: look[1] }, variant === 'ghost' && styles.ghostText]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 9 },
  text: { fontSize: 11.5, fontWeight: '600' },
  ghostText: { fontWeight: '500' },
});
