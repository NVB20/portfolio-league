// The order controls, shared by the ticket (stage 1) and the order center beside the chart (stage 2):
// buy/sell switch, ₪ amount, quick amounts, and the send button with its two-step confirm.
//
// UI ONLY for now: confirming shows a toast and sends nothing. POST /me/orders comes with the game engine.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { ils } from '../../dashboard/format';
import { cleanAmount, type Side } from '../../trade/orderCheck';
import { Button } from '../dashboard/Button';
import { ltr } from '../dashboard/layout';

export function SideToggle({ side, onChange }: { side: Side; onChange: (s: Side) => void }) {
  const { colors } = useTheme();
  const opt = (s: Side, label: string) => {
    const on = side === s;
    const bg = on ? (s === 'buy' ? colors.accent : colors.inverse) : 'transparent';
    const fg = on ? (s === 'buy' ? colors.accentInk : colors.inverseInk) : colors.muted;
    return (
      <Pressable
        key={s}
        onPress={() => onChange(s)}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        style={[styles.segBtn, { backgroundColor: bg }]}
      >
        <Text style={[styles.segText, { color: fg }]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="סוג פקודה" style={[styles.seg, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {opt('buy', 'קנייה')}
      {opt('sell', 'מכירה')}
    </View>
  );
}

export function AmountField({ value, onChange, compact = false }: { value: string; onChange: (v: string) => void; compact?: boolean }) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Text style={[styles.label, { color: colors.faint }]}>סכום בשקלים</Text>
      <View style={[styles.inp, compact && styles.inpCompact, { backgroundColor: colors.surface, borderColor: focused ? colors.accent : colors.line2 }]}>
        <Text style={[styles.cur, { color: colors.faint }]}>₪</Text>
        <TextInput
          value={value}
          onChangeText={(t) => onChange(cleanAmount(t))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={7}
          autoComplete="off"
          autoCorrect={false}
          accessibilityLabel="סכום בשקלים"
          placeholder="0"
          placeholderTextColor={colors.faint}
          style={[styles.input, compact && styles.inputCompact, ltr, { color: colors.fg }, webNoOutline]}
        />
      </View>
    </View>
  );
}

// ₪10,000 / ₪25,000 / ₪50,000 / the most allowed (buy) or everything (sell).
export function QuickAmounts({ side, max, onPick }: { side: Side; max: number; onPick: (v: number) => void }) {
  const { colors } = useTheme();
  const items: [string, number][] = [
    [ils(10_000), 10_000],
    [ils(25_000), 25_000],
    [ils(50_000), 50_000],
    [side === 'buy' ? 'המקסימום המותר' : 'הכל', Math.floor(max)],
  ];
  return (
    <View style={styles.quick}>
      {items.map(([label, v]) => (
        <Pressable key={label} onPress={() => onPick(v)} accessibilityRole="button" style={[styles.quickBtn, { borderColor: colors.line2, backgroundColor: colors.surface }]}>
          <Text style={[styles.quickText, { color: colors.muted }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// The send button. First press asks to confirm (an order can't be cancelled); the second "sends".
// Any change to the order (side, amount, security) closes the confirm step: `orderKey` changes.
export function SendBox({ side, amount, ok, execLine, orderKey, onConfirm }: {
  side: Side;
  amount: number;
  ok: boolean;
  execLine: string;      // "שער הפתיחה · 16:30 · NASDAQ"
  orderKey: string;
  onConfirm: () => void;
}) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [orderKey]);
  const verb = side === 'buy' ? 'קנייה' : 'מכירה';

  if (confirming) {
    return (
      <View style={styles.send}>
        <Text style={[styles.warn, { color: colors.warn }]}>לא ניתן לבטל אחרי השליחה.</Text>
        <View style={styles.pair}>
          <View style={styles.flex}>
            <Button
              label={`אשר ${verb} · ${ils(amount)}`}
              variant="primary"
              onPress={() => {
                setConfirming(false);
                onConfirm();
              }}
            />
          </View>
          <View style={styles.flex}>
            <Button label="חזור" onPress={() => setConfirming(false)} />
          </View>
        </View>
        <Text style={[styles.warn, { color: colors.faint }]}>{execLine}</Text>
      </View>
    );
  }

  return (
    <View style={styles.send}>
      <Button label={`שלח פקודת ${verb}`} variant="primary" disabled={!ok} onPress={() => setConfirming(true)} />
      <Text style={[styles.warn, { color: colors.faint }]}>פקודה שנשלחה לא ניתנת לביטול.</Text>
    </View>
  );
}

// A short message at the bottom of the screen that fades after a few seconds.
export function Toast({ message }: { message: string | null }) {
  const { colors } = useTheme();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.toast, { backgroundColor: colors.inverse }, toastShadow]}>
        <Text style={[styles.toastText, { color: colors.inverseInk }]}>{message}</Text>
      </View>
    </View>
  );
}

const webNoOutline = { outlineStyle: 'none' } as unknown as object;
const toastShadow = { boxShadow: '0 20px 40px -20px rgba(0,0,0,.9)' } as unknown as object;

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 999, borderWidth: 1 },
  segBtn: { flex: 1, borderRadius: 999, paddingVertical: 10, alignItems: 'center' },
  segText: { fontSize: 14, fontWeight: '600' },
  label: { fontSize: 12, marginBottom: 6 },
  inp: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 16 },
  inpCompact: { paddingVertical: 6, paddingHorizontal: 14 },
  cur: { fontSize: 22, fontWeight: '500' },
  input: { flex: 1, minWidth: 0, fontSize: 30, fontWeight: '500', letterSpacing: -0.5, textAlign: 'left', paddingVertical: 2 },
  inputCompact: { fontSize: 24 },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  quickBtn: { borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  quickText: { fontSize: 12.5, fontWeight: '500' },
  send: { gap: 8 },
  warn: { fontSize: 12, textAlign: 'center' },
  pair: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  // In the RTL page flex-end is the LEFT edge: the toast sits opposite the right-hand side where a Hebrew page starts.
  toastWrap: { position: 'absolute', bottom: 20, left: 16, right: 16, alignItems: 'flex-end' },
  toast: { borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, maxWidth: 420 },
  toastText: { fontSize: 13.5, fontWeight: '600' },
});
