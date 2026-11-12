// The row of segments at the top of a walkthrough: the steps done so far (and the current one) are filled.
// Player: the segments share the width, and the bar is one image with a spoken label ("שלב 2 מתוך 6").
// Admin: fixed 24px segments next to a text label that already says the step, so the segments are hidden from
// screen readers.

import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../useTheme';

type Props = {
  step: number;       // 0-based index of the current step
  total: number;
  label?: string;     // spoken text; without it the bar is decorative
  segment?: number;   // fixed segment width; the default is to share the available width
};

export function ProgressBar({ step, total, label, segment }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.row, segment === undefined && styles.grow]}
      accessible={label !== undefined}
      accessibilityRole={label !== undefined ? 'image' : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label !== undefined ? 'yes' : 'no-hide-descendants'}
      aria-hidden={label === undefined ? true : undefined}
    >
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[
            styles.seg,
            segment === undefined ? styles.share : { width: segment },
            { backgroundColor: i <= step ? colors.accent : colors.line2 },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6 },
  grow: { flex: 1 },
  seg: { height: 4, borderRadius: 2 },
  share: { flex: 1 },
});
