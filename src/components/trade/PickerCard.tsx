// All 40 securities in the world (D-011), filterable: all / Tel Aviv / US / mine.
// A dot = you hold it. Pressing one selects it for the whole screen (not while an order is on its way).

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SecurityView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { pct } from '../../dashboard/format';
import { money } from '../../trade/copy';
import { Card } from '../dashboard/Card';
import { Chip } from '../dashboard/Chip';
import { useLayout } from '../dashboard/layout';

type Filter = 'all' | 'tase' | 'us' | 'held';
const FILTERS: [Filter, string][] = [['all', 'הכל'], ['tase', 'תל אביב'], ['us', 'ארה״ב'], ['held', 'שלי']];

export function PickerCard({ securities, selected, onPick, taseOpen, disabled = false }: {
  securities: SecurityView[];
  selected: string | null;
  onPick: (symbol: string) => void;
  taseOpen: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const { width } = useLayout();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = securities.filter(
    (s) => filter === 'all' || (filter === 'tase' && s.market === 'TASE') || (filter === 'us' && s.market === 'US') || (filter === 'held' && s.holding),
  );
  const columns = width >= 560 ? 4 : 2;

  return (
    <Card
      title={`כל ${securities.length} הניירות בעולם`}
      sub="נקודה ירוקה = אתה מחזיק. לחץ כדי לבחור."
      end={<Chip>{taseOpen ? 'תל אביב פתוח' : 'תל אביב סגור'}</Chip>}
    >
      <View style={styles.filters} accessibilityRole="tablist">
        {FILTERS.map(([f, label]) => {
          const on = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.filter, { borderColor: on ? colors.faint : colors.line2, backgroundColor: on ? colors.surface2 : 'transparent' }]}
            >
              <Text style={[styles.filterText, { color: on ? colors.fg : colors.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {rows.length === 0 ? (
        <Text style={[styles.none, { color: colors.faint }]}>{filter === 'held' ? 'עוד אין לך ניירות.' : 'אין ניירות.'}</Text>
      ) : (
        <View style={styles.grid}>
          {rows.map((s) => (
            <Ticker key={s.symbol} s={s} on={s.symbol === selected} basis={`${100 / columns - 1.6}%`} disabled={disabled} onPress={() => onPick(s.symbol)} />
          ))}
        </View>
      )}
    </Card>
  );
}

function Ticker({ s, on, basis, disabled, onPress }: { s: SecurityView; on: boolean; basis: `${number}%`; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const us = s.currency === 'USD';
  const change = s.dayChangePct;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={`${s.nameHe} ${s.symbol}`}
      style={({ hovered }: { hovered?: boolean }) => [
        styles.tkb,
        { flexBasis: basis, maxWidth: basis, borderColor: on ? colors.accent : hovered && !disabled ? colors.faint : colors.line, backgroundColor: on ? colors.accentTint : colors.surface2 },
        disabled && !on && { opacity: 0.6 },
      ]}
    >
      <View style={styles.r1}>
        <Text style={[styles.pill, { color: us ? colors.muted : colors.accent, backgroundColor: us ? colors.surface : colors.accentTint }]}>{s.symbol}</Text>
        {s.holding ? <View style={[styles.held, { backgroundColor: colors.accent }]} /> : null}
      </View>
      <Text numberOfLines={1} style={[styles.name, { color: colors.muted }]}>{s.nameHe}</Text>
      <View style={styles.r2}>
        <Text style={[styles.price, { color: colors.fg }]}>{s.price === null ? '–' : money(s.price, s.currency)}</Text>
        {change !== null ? (
          <Text style={[styles.change, { color: change >= 0 ? colors.accent : colors.neg }]}>{pct(change, { digits: 1 })}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  filter: { borderWidth: 1, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  filterText: { fontSize: 12, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  tkb: { flexGrow: 1, minWidth: 0, borderWidth: 1, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12, gap: 4 },
  r1: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pill: { fontSize: 12, fontWeight: '600', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8, overflow: 'hidden' },
  held: { width: 6, height: 6, borderRadius: 3 },
  name: { fontSize: 12.5, fontWeight: '500' },
  r2: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  price: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontVariant: ['tabular-nums'] },
  none: { fontSize: 13, marginTop: 14 },
});
