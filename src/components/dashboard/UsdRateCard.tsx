// The USD/ILS rate (rule 5): US securities are bought in dollars and converted at the rate at execution.

import { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import type { UsdIlsView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { ils, pct } from '../../dashboard/format';
import { Card, Empty } from './Card';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { CHART_FONT, ltr } from './layout';

export function UsdRateCard({ usd }: { usd: UsdIlsView | null }) {
  const { colors } = useTheme();
  const change = usd?.weekChangePct ?? null;
  return (
    <Card
      title="שער הדולר"
      sub="ניירות ארה״ב נקנים בדולרים ומומרים לפי השער ברגע הביצוע"
      end={
        <>
          {change !== null ? (
            <Chip variant={change >= 0 ? 'up' : 'down'}>{`${change >= 0 ? '▲' : '▼'} ${pct(Math.abs(change), { signed: false })} השבוע`}</Chip>
          ) : null}
          <IconButton label="פתח את גרף הדולר" />
        </>
      }
    >
      {usd ? (
        <>
          <View style={styles.kv}>
            <Text style={[styles.rate, { color: colors.fg }]}>{ils(usd.rate, 2)}</Text>
            <Text style={[styles.pair, { color: colors.faint }]}>USD / ILS</Text>
          </View>
          {usd.series.length > 1 ? <Sparkline values={usd.series.map((p) => p.value)} /> : null}
        </>
      ) : (
        <Empty>אין עדיין נתוני שער. השער ייטען יחד עם מחירי הניירות.</Empty>
      )}
    </Card>
  );
}

const W = 680;
const H = 110;
const PAD = { left: 6, right: 60, top: 14, bottom: 14 };

function Sparkline({ values }: { values: number[] }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || hi * 0.01;
  const x = (i: number) => PAD.left + (W - PAD.left - PAD.right) * (i / (values.length - 1));
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - (v - lo) / span);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lx = x(values.length - 1);
  const ly = y(values[values.length - 1]);

  return (
    <View style={[styles.slim, ltr]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={(width * H) / W} viewBox={`0 0 ${W} ${H}`}>
          <Path d={`${d} L${lx},${H - PAD.bottom} L${PAD.left},${H - PAD.bottom} Z`} fill={colors.accent} opacity={0.1} />
          <Path d={d} fill="none" stroke={colors.muted} strokeWidth={1.8} strokeLinecap="round" />
          <Circle cx={lx} cy={ly} r={4} fill={colors.accent} stroke={colors.surface} strokeWidth={2} />
          <Rect x={lx + 8} y={ly - 10} width={48} height={20} rx={10} fill={colors.accent} />
          <SvgText fontFamily={CHART_FONT} x={lx + 32} y={ly + 4} textAnchor="middle" fontSize={10.5} fontWeight="600" fill={colors.accentInk}>
            {ils(values[values.length - 1], 2)}
          </SvgText>
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  kv: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 12 },
  rate: { fontSize: 30, fontWeight: '500', letterSpacing: -0.5 },
  pair: { fontSize: 13 },
  slim: { marginTop: 10 },
});
