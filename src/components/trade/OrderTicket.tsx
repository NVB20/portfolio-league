// The order controls, shared by the ticket (stage 1) and the order center beside the chart (stage 2):
// buy/sell switch, ₪ amount, quick amounts, and the send button with its two-step confirm.
// The screen does the sending (useSendOrder) and holds the one confirm step both send boxes show; these only
// ask for it. While an order is on its way, everything that would change it is disabled.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { ils } from '../../dashboard/format';
import { cleanAmount, MIN_ORDER_ILS, type Side } from '../../trade/orderCheck';
import { Button } from '../dashboard/Button';
import { ltr } from '../dashboard/layout';

export function SideToggle({ side, onChange, disabled = false }: { side: Side; onChange: (s: Side) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const opt = (s: Side, label: string) => {
    const on = side === s;
    const bg = on ? (s === 'buy' ? colors.accent : colors.inverse) : 'transparent';
    const fg = on ? (s === 'buy' ? colors.accentInk : colors.inverseInk) : colors.muted;
    return (
      <Pressable
        key={s}
        onPress={() => onChange(s)}
        disabled={disabled}
        accessibilityRole="radio"
        accessibilityState={{ checked: on, disabled }}
        style={[styles.segBtn, { backgroundColor: bg }, disabled && !on && styles.off]}
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

export function AmountField({ value, onChange, compact = false, disabled = false }: {
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Text style={[styles.label, { color: colors.faint }]}>סכום בשקלים</Text>
      <View style={[styles.inp, compact && styles.inpCompact, { backgroundColor: colors.surface, borderColor: focused ? colors.accent : colors.line2 }, disabled && styles.off]}>
        <Text style={[styles.cur, { color: colors.faint }]}>₪</Text>
        <TextInput
          value={value}
          onChangeText={(t) => onChange(cleanAmount(t))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!disabled}
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

// ₪10,000 / ₪25,000 / ₪50,000 / the most allowed (buy) or every free unit (sell: `max` is their value as
// shown, which sells them all). The last one is off when there is nothing it could fill in (a buy under the
// ₪100 minimum, a sell with no free unit), so the preview keeps saying why instead of "enter an amount".
export function QuickAmounts({ side, max, onPick, disabled = false }: { side: Side; max: number; onPick: (v: number) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const top = Math.floor(max);
  const items: [string, number, boolean][] = [
    [ils(10_000), 10_000, true],
    [ils(25_000), 25_000, true],
    [ils(50_000), 50_000, true],
    [side === 'buy' ? 'המקסימום המותר' : 'מכור הכל', top, top >= (side === 'buy' ? MIN_ORDER_ILS : 1)],
  ];
  return (
    <View style={styles.quick}>
      {items.map(([label, v, can]) => {
        const off = disabled || !can;
        return (
          <Pressable
            key={label}
            onPress={() => onPick(v)}
            disabled={off}
            accessibilityRole="button"
            accessibilityState={{ disabled: off }}
            style={[styles.quickBtn, { borderColor: colors.line2, backgroundColor: colors.surface }, off && styles.off]}
          >
            <Text style={[styles.quickText, { color: colors.muted }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// The send button. First press asks to confirm (an order can't be cancelled); the second sends.
// The screen holds `confirming`, so both send boxes show the same step and a send from either closes both.
// sending: the order is on its way. updating: the trade data is loading again (after a send, or because the
// clock moved on), so the preview may be out of date: nothing can be sent until it is current.
export function SendBox({ side, amount, ok, execLine, confirming, sending, updating, onOpen, onBack, onConfirm }: {
  side: Side;
  amount: number;
  ok: boolean;
  execLine: string;      // "שער הפתיחה · 16:30 · NASDAQ"
  confirming: boolean;
  sending: boolean;
  updating: boolean;
  onOpen: () => void;      // open the confirm step
  onBack: () => void;      // close it without sending
  onConfirm: () => void;   // send (the screen closes the step when done, or keeps it for a safe retry)
}) {
  const { colors } = useTheme();
  const verb = side === 'buy' ? 'קנייה' : 'מכירה';
  const wait = sending ? 'שולח…' : updating ? 'מעדכן…' : null;

  if (confirming) {
    return (
      <View style={styles.send}>
        <Text style={[styles.warn, { color: colors.warn }]}>לא ניתן לבטל אחרי השליחה.</Text>
        <View style={styles.pair}>
          <View style={styles.flex}>
            <Button label={wait ?? `אשר ${verb} · ${ils(amount)}`} variant="primary" disabled={wait !== null || !ok} onPress={onConfirm} />
          </View>
          <View style={styles.flex}>
            <Button label="חזור" disabled={sending} onPress={onBack} />
          </View>
        </View>
        <Text style={[styles.warn, { color: colors.faint }]}>{execLine}</Text>
      </View>
    );
  }

  return (
    <View style={styles.send}>
      <Button label={wait ?? `שלח פקודת ${verb}`} variant="primary" disabled={!ok || wait !== null} onPress={onOpen} />
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
  off: { opacity: 0.45 },
  send: { gap: 8 },
  warn: { fontSize: 12, textAlign: 'center' },
  pair: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  // In the RTL page flex-end is the LEFT edge: the toast sits opposite the right-hand side where a Hebrew page starts.
  toastWrap: { position: 'absolute', bottom: 20, left: 16, right: 16, alignItems: 'flex-end' },
  toast: { borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, maxWidth: 420 },
  toastText: { fontSize: 13.5, fontWeight: '600' },
});
