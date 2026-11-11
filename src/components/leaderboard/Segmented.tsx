// A row of options where exactly one is on (the mock-up's `.seg.lg`): the table's "ראש הטבלה / סביבי".
// Two options, not one toggle: a toggle's label leaves you guessing whether it's the state or the action.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';

export type SegOption<T extends string> = { value: T; label: string; disabled?: boolean; hint?: string };

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;   // what the group switches, for screen readers
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.seg, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {options.map((o) => {
        const on = o.value === value;
        const disabled = o.disabled ?? false;
        return (
          <Pressable
            key={o.value}
            onPress={on ? undefined : () => onChange(o.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            // react-native-web doesn't turn accessibilityState into ARIA; aria-checked reaches the web too.
            aria-checked={on}
            accessibilityHint={o.hint}
            style={({ pressed }) => [
              styles.option,
              on && { backgroundColor: colors.accent },
              !on && pressed && { backgroundColor: colors.surface2 },
              disabled && styles.off,
            ]}
          >
            <Text style={[styles.text, { color: on ? colors.accentInk : colors.muted }, on && styles.onText]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start' },
  option: { minHeight: 36, paddingHorizontal: 14, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 13, fontWeight: '500' },
  onText: { fontWeight: '600' },
  off: { opacity: 0.45 },
});
