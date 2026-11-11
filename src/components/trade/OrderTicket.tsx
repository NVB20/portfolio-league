// The order controls, shared by the ticket (stage 1) and the order center beside the chart (stage 2):
// buy/sell switch, ₪ amount, the amount slider, the optional stop loss (D-037), the send button, and the confirm
// popup it opens.
// The screen does the sending (useSendOrder) and holds the one confirm popup both send buttons open; these only
// ask for it. While an order is on its way, everything that would change it is disabled.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../useTheme';
import { ils } from '../../dashboard/format';
import { STOP_HINT, STOP_TIP, stopLine } from '../../trade/copy';
import {
  cleanAmount, cleanPrice, groupAmount, MIN_ORDER_ILS, SLIDER_STEP, sliderAmount, sliderRange, sliderRatio, type Side, type StopCheck,
} from '../../trade/orderCheck';
import { Button } from '../dashboard/Button';
import { InfoButton } from '../dashboard/InfoTip';
import { ltr, rtl } from '../dashboard/layout';
import { useReduce } from '../dashboard/motion';

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

// `value` is digits only; the field shows them with commas (100,000), and cleanAmount takes the commas out again.
// No maxLength: the commas would count toward it, and cleanAmount already stops at 7 digits.
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
          value={groupAmount(value)}
          onChangeText={(t) => onChange(cleanAmount(t))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!disabled}
          keyboardType="number-pad"
          inputMode="numeric"
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

const THUMB = 22;

// The amount as a slider, from the ₪100 minimum to the most this order may be (`max` = Check.maxIls: a buy's
// available cash and the 20% room left in this security, a sell's free units, whose far end sells them all).
// It follows what is typed, and moving it types the amount. The minimum is on the left, like the weight bars
// and the amount field. It is off when there is nothing it could pick, so the preview keeps saying why.
export function AmountSlider({ side, value, max, onPick, disabled = false }: {
  side: Side;
  value: number;
  max: number;
  onPick: (v: number) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const range = sliderRange(side, max);
  const off = disabled || !range;
  const [width, setWidth] = useState(0);
  const x = (range ? sliderRatio(value, range) : 0) * Math.max(0, width - THUMB);   // the thumb's left edge

  // The drag handler is made once and reads the latest props from here.
  const live = useRef({ range, off, width, onPick });
  live.current = { range, off, width, onPick };
  // Where the drag started along the track. A ref, not a variable inside the handler: React may not reassign a
  // render's variable after the render is done.
  const startX = useRef(0);
  const pan = useMemo(() => {
    const pickAt = (px: number) => {
      const { range: r, width: w, onPick: pick } = live.current;
      if (r && w > THUMB) pick(sliderAmount((px - THUMB / 2) / (w - THUMB), r));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.off,
      onMoveShouldSetPanResponder: () => !live.current.off,
      onPanResponderTerminationRequest: () => false,   // a drag that drifts up or down stays a drag, not a scroll
      // The children ignore touches, so locationX is along the track; a move adds how far the finger went.
      onPanResponderGrant: (e) => {
        startX.current = e.nativeEvent.locationX;
        pickAt(startX.current);
      },
      onPanResponderMove: (_, g) => pickAt(startX.current + g.dx),
    });
  }, []);

  // Arrow keys (web) and screen readers move it by a twentieth of the range.
  const nudge = range ? Math.max(SLIDER_STEP, Math.round((range.hi - range.lo) / 20 / SLIDER_STEP) * SLIDER_STEP) : 0;
  const to = (v: number) => {
    if (range && !off) onPick(Math.min(range.hi, Math.max(range.lo, v)));
  };
  const keys = {
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (!range) return;
      const v = ({ ArrowRight: value + nudge, ArrowUp: value + nudge, ArrowLeft: value - nudge, ArrowDown: value - nudge, Home: range.lo, End: range.hi } as Record<string, number>)[e.key];
      if (v === undefined) return;
      e.preventDefault();
      to(v);
    },
  } as object;

  return (
    <View style={styles.slider}>
      <View
        {...pan.panHandlers}
        {...keys}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        focusable={!off}
        accessibilityRole="adjustable"
        accessibilityLabel="סכום הפקודה"
        accessibilityState={{ disabled: off }}
        accessibilityValue={range ? { min: range.lo, max: range.hi, now: Math.min(range.hi, Math.max(range.lo, value)), text: ils(value) } : undefined}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => to(value + (e.nativeEvent.actionName === 'increment' ? nudge : -nudge))}
        style={[styles.track, ltr, off ? styles.off : webDrag]}
      >
        <View style={[styles.rail, { backgroundColor: colors.line2 }]} />
        <View style={[styles.fill, { width: x + THUMB / 2, backgroundColor: colors.accent }]} />
        <View style={[styles.thumb, { left: x, backgroundColor: colors.accent, borderColor: colors.page }]} />
      </View>
      <View style={[styles.ends, ltr]}>
        <Text style={[styles.endText, { color: colors.faint }]}>{ils(range?.lo ?? MIN_ORDER_ILS)}</Text>
        <Text style={[styles.endText, { color: colors.faint }]}>{`${side === 'buy' ? 'מקסימום' : 'הכל'} ${ils(Math.max(0, Math.floor(max)))}`}</Text>
      </View>
    </View>
  );
}

// The optional stop loss on a buy (D-037). The ⓘ beside the switch says, BEFORE it is turned on, that the stop is
// checked only at the open and the close (the game trades at those two prices only), and the line under it says it
// again. On, a price in the security's own currency. That price IS the position tool's stop: the chart's stop line,
// the order center's "סטופ" field and this one move together. Typing applies on blur or enter, like the levels.
export function StopLossField({ on, onToggle, stop, currency, check, onStop, disabled = false }: {
  on: boolean;
  onToggle: () => void;
  stop: number;                  // the position tool's stop level
  currency: 'ILS' | 'USD';
  check: StopCheck;
  onStop: (v: number) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(stop.toFixed(2));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(stop.toFixed(2));
  }, [stop, focused]);
  const apply = () => {
    const v = Math.min(9_999_999, Number(text) || 0);
    if (v >= 0.01) onStop(v);
    else setText(stop.toFixed(2));
  };
  return (
    <View style={styles.stop}>
      <View style={styles.stopHead}>
        <View style={styles.stopLabel}>
          <Text style={[styles.stopTitle, { color: colors.fg }]}>סטופ לוס</Text>
          <InfoButton tip={STOP_TIP} label="איך עובד סטופ לוס במשחק" />
        </View>
        <Pressable
          onPress={onToggle}
          disabled={disabled}
          accessibilityRole="switch"
          accessibilityLabel="סטופ לוס"
          accessibilityState={{ checked: on, disabled }}
          style={[styles.stopToggle, { borderColor: on ? colors.neg : colors.line2 }, disabled && styles.off]}
        >
          <Ionicons name={on ? 'shield-checkmark' : 'shield-outline'} size={13} color={on ? colors.neg : colors.muted} />
          <Text style={[styles.stopToggleText, { color: on ? colors.neg : colors.muted }]}>{on ? 'מופעל' : 'הוסף'}</Text>
        </Pressable>
      </View>
      <Text style={[styles.stopHint, { color: colors.faint }]}>{STOP_HINT}</Text>
      {on ? (
        <>
          <View style={[styles.inp, styles.inpStop, { backgroundColor: colors.surface, borderColor: focused ? colors.accent : colors.line2 }, disabled && styles.off]}>
            <Text style={[styles.curStop, { color: colors.faint }]}>{currency === 'USD' ? '$' : '₪'}</Text>
            <TextInput
              value={text}
              onChangeText={(t) => setText(cleanPrice(t))}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                apply();
              }}
              onSubmitEditing={apply}
              editable={!disabled}
              keyboardType="decimal-pad"
              inputMode="decimal"
              maxLength={10}
              accessibilityLabel="מחיר הסטופ לוס"
              style={[styles.inputStop, ltr, { color: colors.fg }, webNoOutline]}
            />
          </View>
          <Text style={[styles.stopHint, { color: check.ok ? colors.faint : colors.neg }]}>{stopLine(check)}</Text>
        </>
      ) : null}
    </View>
  );
}

// The send button. It opens the confirm popup (an order can't be cancelled); the popup's button sends.
// sending: the order is on its way. updating: the trade data is loading again (after a send, or because the
// clock moved on), so the preview may be out of date: nothing can be sent until it is current.
export function SendBox({ side, ok, sending, updating, onOpen }: {
  side: Side;
  ok: boolean;
  sending: boolean;
  updating: boolean;
  onOpen: () => void;   // open the confirm popup
}) {
  const { colors } = useTheme();
  const wait = sending ? 'שולח…' : updating ? 'מעדכן…' : null;
  return (
    <View style={styles.send}>
      <Button label={wait ?? `שלח פקודת ${side === 'buy' ? 'קנייה' : 'מכירה'}`} variant="primary" disabled={!ok || wait !== null} onPress={onOpen} />
      <Text style={[styles.warn, { color: colors.faint }]}>פקודה שנשלחה לא ניתנת לביטול.</Text>
    </View>
  );
}

// The confirm step, as a popup over the screen: the order, when it executes, and that it can't be cancelled.
// A tap outside, Escape or back closes it without sending (the screen ignores that while the order is on its
// way). The screen keeps it open after a failure where pressing again is safe, with the reason in `error`.
export function ConfirmOrder({ open, side, symbol, name, amount, units, execLine, stopLine: stopRow, ok, blocked, error, sending, updating, onBack, onConfirm }: {
  open: boolean;
  side: Side;
  symbol: string;
  name: string;            // the security's Hebrew name
  amount: number;
  units: number;           // estimated for a buy, exact for a sell (D-018)
  execLine: string;        // "שער הפתיחה · 16:30 · NASDAQ"; '' when not known
  stopLine: string;        // "₪95.00 (−4.0%) · נבדק בפתיחה ובסגירה"; '' = no stop loss (D-037)
  ok: boolean;
  blocked: string | null;  // why it can't be sent any more (the data was loaded again), shown when !ok
  error: string | null;    // the last send failed but pressing again is safe
  sending: boolean;
  updating: boolean;
  onBack: () => void;      // close without sending
  onConfirm: () => void;   // send (the screen closes the popup when done)
}) {
  const { colors } = useTheme();
  const reduce = useReduce();
  const verb = side === 'buy' ? 'קנייה' : 'מכירה';
  const wait = sending ? 'שולח…' : updating ? 'מעדכן…' : null;
  const n = units.toLocaleString('en-US', { maximumFractionDigits: side === 'sell' ? 8 : 3 });
  return (
    <Modal visible={open} transparent animationType={reduce ? 'none' : 'fade'} onRequestClose={onBack}>
      {/* The Modal renders outside the screen's tree, so the Hebrew direction is set again here. */}
      <Pressable style={[styles.scrim, rtl]} onPress={onBack} accessibilityLabel="סגירה בלי לשלוח">
        {/* Inner Pressable swallows taps so tapping inside the popup doesn't close it. */}
        <Pressable
          onPress={() => {}}
          role="dialog"
          aria-modal
          aria-label={`אישור פקודת ${verb}`}
          style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.line2 }, dialogShadow]}
        >
          <View>
            <Text style={[styles.dTitle, { color: colors.fg }]}>{`אישור פקודת ${verb}`}</Text>
            <Text style={[styles.dSub, { color: colors.faint }]}>{`${name} · ${symbol}`}</Text>
          </View>
          <Text style={[styles.dAmount, { color: colors.fg }]}>{ils(amount)}</Text>
          <View>
            <DRow label={side === 'sell' ? 'יחידות למכירה' : 'יחידות משוערות'} value={n} />
            {execLine ? <DRow label="מועד ביצוע" value={execLine} /> : null}
            {stopRow ? <DRow label="סטופ לוס" value={stopRow} /> : null}
          </View>
          <Text style={[styles.warn, { color: colors.warn }]}>לא ניתן לבטל אחרי השליחה.</Text>
          {error ? <Text accessibilityRole="alert" style={[styles.warn, { color: colors.neg }]}>{error}</Text> : null}
          {!ok && !wait && blocked ? <Text style={[styles.warn, { color: colors.neg }]}>{`אי אפשר לשלוח: ${blocked}`}</Text> : null}
          <View style={styles.pair}>
            <View style={styles.flex}>
              <Button label={wait ?? `אשר ${verb} · ${ils(amount)}`} variant="primary" disabled={wait !== null || !ok} onPress={onConfirm} />
            </View>
            <View style={styles.flex}>
              <Button label="חזור" disabled={sending} onPress={onBack} />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.dRow, { borderTopColor: colors.line }]}>
      <Text style={[styles.dLabel, { color: colors.faint }]}>{label}</Text>
      <Text style={[styles.dValue, { color: colors.fg }]}>{value}</Text>
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
const dialogShadow = { boxShadow: '0 30px 60px -20px rgba(0,0,0,.8)' } as unknown as object;
// Web: a touch drag on the slider moves it instead of scrolling the page, and a mouse drag selects no text.
const webDrag = { touchAction: 'none', cursor: 'pointer', userSelect: 'none' } as unknown as object;

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
  slider: { marginTop: 10 },
  // 28px tall to be easy to grab; the 4px rail sits in the middle. The children ignore touches (see AmountSlider).
  track: { height: 28 },
  rail: { position: 'absolute', left: 0, right: 0, top: 12, height: 4, borderRadius: 2, pointerEvents: 'none' },
  fill: { position: 'absolute', left: 0, top: 12, height: 4, borderRadius: 2, pointerEvents: 'none' },
  thumb: { position: 'absolute', top: 3, width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 3, pointerEvents: 'none' },
  ends: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  endText: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  off: { opacity: 0.45 },
  stop: { gap: 6 },
  stopHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  stopLabel: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stopTitle: { fontSize: 13.5, fontWeight: '600' },
  stopToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  stopToggleText: { fontSize: 11.5, fontWeight: '500' },
  stopHint: { fontSize: 11.5 },
  inpStop: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14 },
  curStop: { fontSize: 16, fontWeight: '500' },
  inputStop: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '500', textAlign: 'left', paddingVertical: 2 },
  send: { gap: 8 },
  warn: { fontSize: 12, textAlign: 'center' },
  pair: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: 'rgba(4, 10, 12, 0.6)' },
  dialog: { width: '100%', maxWidth: 380, borderWidth: 1, borderRadius: 22, padding: 20, gap: 14 },
  dTitle: { fontSize: 18, fontWeight: '600' },
  dSub: { fontSize: 12.5, marginTop: 2 },
  dAmount: { fontSize: 34, fontWeight: '500', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  dRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingVertical: 9, borderTopWidth: 1 },
  dLabel: { fontSize: 13 },
  dValue: { flexShrink: 1, fontSize: 13.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  // In the RTL page flex-end is the LEFT edge: the toast sits opposite the right-hand side where a Hebrew page starts.
  toastWrap: { position: 'absolute', bottom: 20, left: 16, right: 16, alignItems: 'flex-end' },
  toast: { borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, maxWidth: 420 },
  toastText: { fontSize: 13.5, fontWeight: '600' },
});
