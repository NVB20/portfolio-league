// Moving a live stop loss (D-041): the pencil beside a stop, and the small editor it opens under that line. Used by
// the dashboard's holding cards and the journal's rows, for active stops only (a filled buy whose position is still
// open, fully or partly). Colors come from usePalette(), so the editor flips with an inverse holding card.
//
// The price field checks the same rule as the server (checkStop: below the latest close) as the player types; the
// server's Hebrew reason shows under it when a save is refused. A save that worked closes the editor and reloads
// the screen (onMoved).

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { checkStop, cleanPrice } from '../../trade/orderCheck';
import { STOP_HINT } from '../../trade/copy';
import { canSaveStop, stopEditLine } from '../../trade/stopMove';
import { useMoveStop } from '../../trade/useMoveStop';
import { usePalette } from '../dashboard/Card';
import { ltr } from '../dashboard/layout';

// The pencil: "✎ שנה". `label` names the stop for screen readers ("הזזת סטופ ₪95.00 של TEVA").
export function StopEditButton({ onPress, label }: { onPress: () => void; label: string }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="פותח שדה למחיר סטופ חדש"
      style={({ pressed }) => [styles.edit, { borderColor: p.line }, pressed && styles.pressed]}
    >
      <Ionicons name="pencil" size={11} color={p.fg} />
      <Text style={[styles.editText, { color: p.fg }]}>שנה</Text>
    </Pressable>
  );
}

type Props = {
  stopId: string;
  price: number;                 // the stop now, in the security's currency
  lastClose: number | null;      // the new price must be below it
  currency: 'ILS' | 'USD';
  onMoved: () => void;           // load the screen again
  onClose: () => void;
};

export function StopEditor({ stopId, price, lastClose, currency, onMoved, onClose }: Props) {
  const p = usePalette();
  const [text, setText] = useState(price.toFixed(2));
  const [focused, setFocused] = useState(false);
  const { busy, error, save } = useMoveStop(onMoved);
  const check = checkStop(Number(text) || 0, lastClose, 0);
  const ok = canSaveStop(check, price) && !busy;

  const submit = async () => {
    if (!ok || check.stop === null) return;
    if (await save(stopId, check.stop)) onClose();
  };

  return (
    <View style={[styles.box, { backgroundColor: p.tile, borderColor: p.line }]}>
      <View style={styles.row}>
        <View style={[styles.inp, { borderColor: focused ? p.accentFill : p.line }]}>
          <Text style={[styles.cur, { color: p.sub }]}>{currency === 'USD' ? '$' : '₪'}</Text>
          <TextInput
            value={text}
            onChangeText={(t) => setText(cleanPrice(t))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitEditing={submit}
            editable={!busy}
            autoFocus
            selectTextOnFocus
            keyboardType="decimal-pad"
            inputMode="decimal"
            maxLength={10}
            accessibilityLabel="מחיר סטופ חדש"
            style={[styles.input, ltr, { color: p.fg }, webNoOutline]}
          />
        </View>
        <Pill label={busy ? 'שומר…' : 'שמור'} primary disabled={!ok} onPress={submit} />
        <Pill label="ביטול" disabled={busy} onPress={onClose} />
      </View>
      <Text style={[styles.line, { color: check.ok ? p.sub : p.down }]}>{stopEditLine(check, lastClose, currency)}</Text>
      <Text style={[styles.line, { color: p.sub }]}>{STOP_HINT}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.line, styles.error, { color: p.down }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// A small button in the card's own colors (the shared Button is drawn for the page, not for an inverse card).
function Pill({ label, onPress, primary = false, disabled = false }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.pill,
        primary ? { backgroundColor: p.accentFill, borderColor: p.accentFill } : { borderColor: p.line },
        (disabled || pressed) && { opacity: disabled ? 0.45 : 0.85 },
      ]}
    >
      <Text style={[styles.pillText, { color: primary ? p.accentFillInk : p.fg }]}>{label}</Text>
    </Pressable>
  );
}

const webNoOutline = { outlineStyle: 'none' } as unknown as object;

const styles = StyleSheet.create({
  edit: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 },
  editText: { fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  box: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 6, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  inp: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minWidth: 120, flexGrow: 1, flexBasis: 120 },
  cur: { fontSize: 13 },
  input: { flex: 1, fontSize: 15, fontVariant: ['tabular-nums'], paddingVertical: 7, paddingHorizontal: 6, minWidth: 0 },
  pill: { borderWidth: 1, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14, alignItems: 'center' },
  pillText: { fontSize: 12.5, fontWeight: '600' },
  line: { fontSize: 11.5 },
  error: { fontWeight: '600' },
});
