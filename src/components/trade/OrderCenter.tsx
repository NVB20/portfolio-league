// Stage 2's headline column: the order controls again (same state as the ticket), plus the position tool's
// entry / target / stop as numbers. Typing a level moves it on the chart; dragging on the chart updates these.
// The target is for planning only. The stop is the order's stop loss when the player turns it on (D-037): it is
// checked only at the open and the close, like every trade (rule 3).

import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ChartBar } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { ils } from '../../dashboard/format';
import { money } from '../../trade/copy';
import { cleanPrice, positionMath, type Levels, type Side } from '../../trade/orderCheck';
import { Card } from '../dashboard/Card';
import { Chip } from '../dashboard/Chip';
import { ltr } from '../dashboard/layout';

const MINUS = '−';
const signed = (v: number, text: string) => `${v >= 0 ? '+' : MINUS}${text}`;

export function LevelInputs({ levels, currency, onChange }: {
  levels: Levels;
  currency: 'ILS' | 'USD';
  onChange: (key: keyof Levels, value: number) => void;
}) {
  return (
    <View style={styles.lv}>
      <LevelField k="target" label="יעד" dot="accent" levels={levels} currency={currency} onChange={onChange} />
      <LevelField k="entry" label="כניסה" dot="fg" levels={levels} currency={currency} onChange={onChange} />
      <LevelField k="stop" label="סטופ" dot="neg" levels={levels} currency={currency} onChange={onChange} />
    </View>
  );
}

// Shows the level while not being edited; while typing it keeps the text, and applies it on blur / enter.
function LevelField({ k, label, dot, levels, onChange }: {
  k: keyof Levels;
  label: string;
  dot: 'accent' | 'fg' | 'neg';
  levels: Levels;
  currency: 'ILS' | 'USD';
  onChange: (key: keyof Levels, value: number) => void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState(levels[k].toFixed(2));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(levels[k].toFixed(2));
  }, [levels, k, focused]);
  const apply = () => {
    const v = Math.min(9_999_999, Number(text) || 0);
    if (v >= 0.01) onChange(k, v);
    else setText(levels[k].toFixed(2));
  };
  return (
    <View style={styles.lvItem}>
      <View style={styles.lvLabel}>
        <View style={[styles.dot, { backgroundColor: colors[dot] }]} />
        <Text style={[styles.lvText, { color: colors.faint }]}>{label}</Text>
      </View>
      <TextInput
        value={text}
        onChangeText={(t) => setText(cleanPrice(t))}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          apply();
        }}
        onSubmitEditing={apply}
        keyboardType="decimal-pad"
        inputMode="decimal"
        maxLength={10}
        accessibilityLabel={label}
        style={[styles.lvInput, ltr, { color: colors.fg, backgroundColor: colors.surface, borderColor: focused ? colors.accent : colors.line2 }, webNoOutline]}
      />
    </View>
  );
}

// Reward / risk of the planned position for the order amount.
export function RiskReward({ amount, levels, currency, entryIls }: { amount: number; levels: Levels; currency: 'ILS' | 'USD'; entryIls: number }) {
  const { colors } = useTheme();
  const m = positionMath(amount, levels);
  const units = entryIls > 0 ? amount / entryIls : 0;
  const row = (label: string, value: string, color?: string, big = false) => (
    <View key={label} style={[styles.rrRow, { borderTopColor: colors.line }]}>
      <Text style={[styles.rrLabel, { color: colors.faint }]}>{label}</Text>
      <Text style={[styles.rrValue, big && styles.rrBig, { color: color ?? colors.fg }]}>{value}</Text>
    </View>
  );
  return (
    <View style={[styles.rr, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {row('יחס סיכוי / סיכון', `1 : ${m.rr.toFixed(2)}`, undefined, true)}
      {row('רווח ביעד', `${signed(m.reward, ils(Math.abs(m.reward)))} ·${signed(m.tp, `${Math.abs(m.tp * 100).toFixed(1)}%`)}`, colors.accent)}
      {row('הפסד בסטופ', `${MINUS}${ils(Math.abs(m.risk))} · ${MINUS}${(m.sl * 100).toFixed(1)}%`, colors.neg)}
      {row('יחידות בכניסה', `${units.toLocaleString('en-US', { maximumFractionDigits: 2 })} × ${money(levels.entry, currency)}`)}
    </View>
  );
}

export function PositionToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.lbl}>
      <Text style={[styles.lvText, { color: colors.faint }]}>כלי הפוזיציה · לונג</Text>
      <Pressable
        onPress={onToggle}
        accessibilityRole="switch"
        accessibilityState={{ checked: on }}
        style={[styles.toggle, { borderColor: on ? colors.accent : colors.line2 }]}
      >
        <Ionicons name="trending-up" size={13} color={on ? colors.accent : colors.muted} />
        <Text style={[styles.toggleText, { color: on ? colors.accent : colors.muted }]}>{on ? 'מוצג על הגרף' : 'הצג על הגרף'}</Text>
      </Pressable>
    </View>
  );
}

// ---------- the stats strip under the chart ----------

export type Measurement = { from: { time: string; price: number }; to: { time: string; price: number }; bars: number };

const dmy = (t: string) => `${t.slice(8, 10)}.${t.slice(5, 7)}`;

export function StatsStrip({ bars, currency, tf, amount, heldIls, symbol, measurement }: {
  bars: ChartBar[];           // the bars in the selected range
  currency: 'ILS' | 'USD';
  tf: 'D' | 'W';
  amount: number;
  heldIls: number;
  symbol: string;
  measurement: Measurement | null;
}) {
  const { colors } = useTheme();
  const unit = tf === 'W' ? 'שבועות' : 'ימי מסחר';

  if (measurement) {
    const { from, to } = measurement;
    const ch = to.price / from.price - 1;
    const tone = ch >= 0 ? colors.accent : colors.neg;
    return (
      <Card title="מדידה" sub={`${dmy(from.time)} ← ${dmy(to.time)} · גרור שוב למדידה חדשה, Esc לניקוי`} end={<Chip variant={ch >= 0 ? 'up' : 'down'}>{`${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(2)}%`}</Chip>}>
        <Tiles>
          <StatTile value={signed(ch, `${Math.abs(ch * 100).toFixed(2)}%`)} label="שינוי בין הנקודות" color={tone} />
          <StatTile value={String(measurement.bars)} label={unit} />
          <StatTile value={money(to.price, currency)} label={`מ־${money(from.price, currency)}`} small />
          <StatTile value={signed(ch, ils(Math.abs(amount * ch)))} label={`על סכום הפקודה ${ils(amount)}`} color={tone} />
          <StatTile value={heldIls > 0 ? signed(ch, ils(Math.abs(heldIls * ch))) : '–'} label={heldIls > 0 ? `על האחזקה שלך ${ils(heldIls)}` : `אתה לא מחזיק ${symbol}`} color={heldIls > 0 ? tone : undefined} />
        </Tiles>
      </Card>
    );
  }

  if (bars.length < 2) {
    return (
      <Card title="התקופה במספרים">
        <Text style={[styles.empty, { color: colors.faint }]}>הנתונים יופיעו כשהגרף ייטען.</Text>
      </Card>
    );
  }

  const first = bars[0];
  const last = bars[bars.length - 1];
  const ch = last.close / first.close - 1;
  let hi = -Infinity, lo = Infinity, peak = -Infinity, mdd = 0, range = 0, vol = 0;
  for (const b of bars) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
    peak = Math.max(peak, b.close);
    mdd = Math.max(mdd, 1 - b.close / peak);
    range += (b.high - b.low) / b.close;
    vol += b.volume;
  }
  return (
    <Card title="התקופה במספרים" sub={`${bars.length} ${unit} · ${dmy(first.time)} עד ${dmy(last.time)}`} end={<Chip>{tf === 'W' ? 'נתוני שבוע' : 'נתוני יום'}</Chip>}>
      <Tiles>
        <StatTile value={signed(ch, `${Math.abs(ch * 100).toFixed(1)}%`)} label="שינוי בתקופה" color={ch >= 0 ? colors.accent : colors.neg} />
        <StatTile value={`${money(hi, currency)}\n${money(lo, currency)}`} label="שיא · שפל" small />
        <StatTile value={`${MINUS}${(mdd * 100).toFixed(1)}%`} label="ירידה מקסימלית מהשיא" color={colors.warn} />
        <StatTile value={`${((range / bars.length) * 100).toFixed(2)}%`} label={tf === 'W' ? 'תנודה שבועית ממוצעת' : 'תנודה יומית ממוצעת'} />
        <StatTile value={`${(vol / bars.length / 1e6).toFixed(2)}M`} label={tf === 'W' ? 'מחזור שבועי ממוצע' : 'מחזור יומי ממוצע'} />
      </Tiles>
    </Card>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  return <View style={styles.tiles}>{children}</View>;
}

function StatTile({ value, label, color, small = false }: { value: string; label: string; color?: string; small?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface2 }]}>
      <Text style={[styles.tileValue, small && styles.tileSmall, { color: color ?? colors.fg }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: colors.faint }]}>{label}</Text>
    </View>
  );
}

const webNoOutline = { outlineStyle: 'none' } as unknown as object;

const styles = StyleSheet.create({
  lv: { flexDirection: 'row', gap: 6 },
  lvItem: { flex: 1, minWidth: 0, gap: 4 },
  lvLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  lvText: { fontSize: 11.5 },
  lvInput: { borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10, fontSize: 15, fontWeight: '500', textAlign: 'left' },
  rr: { borderWidth: 1, borderRadius: 16, paddingVertical: 2, paddingHorizontal: 14 },
  rrRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingVertical: 8, borderTopWidth: 1 },
  rrLabel: { fontSize: 13 },
  rrValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rrBig: { fontSize: 22 },
  lbl: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  toggleText: { fontSize: 11.5, fontWeight: '500' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  tile: { flexGrow: 1, flexBasis: 140, borderRadius: 16, padding: 14, justifyContent: 'flex-end' },
  tileValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tileSmall: { fontSize: 14, lineHeight: 19 },
  tileLabel: { fontSize: 12, marginTop: 4 },
  empty: { fontSize: 13.5, marginTop: 14 },
});
