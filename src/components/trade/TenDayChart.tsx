// The selected security's last ten trading days + the latest known close: the same daily closes the
// game trades on (stored in Postgres), drawn like the dashboard chart. The line draws in on load.

import { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import type { SecurityView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { WEEKDAY_LETTERS } from '../../dashboard/format';
import { EXCHANGE, executionShort, money } from '../../trade/copy';
import { Card, Empty } from '../dashboard/Card';
import { Chip } from '../dashboard/Chip';
import { CHART_FONT, ltr } from '../dashboard/layout';
import { useTween } from '../dashboard/motion';

const H = 230;
const PAD = { left: 56, right: 16, top: 22, bottom: 26 };

export function TenDayChartCard({ security, today }: { security: SecurityView; today: string | null }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const closes = security.closes;
  const lo = closes.length ? Math.min(...closes.map((c) => c.close)) : 0;
  const hi = closes.length ? Math.max(...closes.map((c) => c.close)) : 0;

  return (
    <Card
      title={`${security.nameHe} · עשרה ימי מסחר`}
      sub={`נסחר ב־${EXCHANGE[security.exchange]} · ${security.currency === 'USD' ? 'מחירים בדולרים' : 'מחירים בשקלים'} · סגירות יומיות`}
      end={closes.length > 1 ? <Chip>{`${money(lo, security.currency)}–${money(hi, security.currency)}`}</Chip> : null}
    >
      {closes.length < 2 ? (
        <Empty>אין עדיין מספיק ימי מסחר לגרף. הוא יתמלא כשהשעון יתקדם.</Empty>
      ) : (
        <>
          {security.execution ? (
            <View style={[styles.exec, { backgroundColor: colors.surface2, borderColor: colors.line2 }]}>
              <Text style={[styles.execLabel, { color: colors.faint }]}>מחיר הביצוע</Text>
              <Text style={[styles.execValue, { color: colors.fg }]}>{executionShort(security.execution, today)}</Text>
            </View>
          ) : null}
          <View style={[styles.chart, ltr]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
            {width > 0 ? <Chart key={security.symbol} width={width} security={security} /> : null}
          </View>
          <View style={styles.legend}>
            <View style={[styles.swatch, { backgroundColor: colors.accent }]} />
            <Text style={[styles.legendText, { color: colors.faint }]}>מחיר סגירה יומי</Text>
          </View>
        </>
      )}
    </Card>
  );
}

function Chart({ width, security }: { width: number; security: SecurityView }) {
  const { colors } = useTheme();
  const draw = useTween({ delay: 200, duration: 900 });   // 0 -> 1: the line draws in (instant under reduce motion)

  const g = useMemo(() => {
    const a = security.closes.map((c) => c.close);
    const min = Math.min(...a) * 0.985;
    const max = Math.max(...a) * 1.015;
    const last = a.length - 1;
    const x = (i: number) => PAD.left + (width - PAD.left - PAD.right) * (i / last);
    const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - (v - min) / (max - min || 1));
    const d = a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const grid = [0, 1, 2, 3].map((k) => min + (max - min) * (k / 3));
    // The line's length, for the draw-in dash trick.
    let len = 0;
    for (let i = 1; i < a.length; i++) len += Math.hypot(x(i) - x(i - 1), y(a[i]) - y(a[i - 1]));
    return { a, last, x, y, d, grid, len };
  }, [security.closes, width]);

  const ex = g.x(g.last);
  const ey = g.y(g.a[g.last]);
  const label = money(g.a[g.last], security.currency);
  const lw = Math.max(70, label.length * 7.5 + 16);
  const lx = Math.min(ex - lw - 10, width - PAD.right - lw);

  return (
    <Svg width={width} height={H}>
      <Defs>
        <LinearGradient id="tenfade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.25} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {g.grid.map((v) => (
        <G key={v}>
          <Line x1={PAD.left} x2={width - PAD.right} y1={g.y(v)} y2={g.y(v)} stroke={colors.line} />
          <SvgText x={PAD.left - 8} y={g.y(v) + 4} fontSize={11} fill={colors.faint} textAnchor="end" fontFamily={CHART_FONT}>
            {money(v, security.currency)}
          </SvgText>
        </G>
      ))}
      {security.closes.map((c, i) =>
        i % 2 === 0 || i === g.last ? (
          <SvgText key={c.day} x={g.x(i)} y={H - 6} fontSize={11} fill={colors.faint} textAnchor="middle" fontFamily={CHART_FONT}>
            {i === g.last ? `${c.day.slice(8, 10)}.${c.day.slice(5, 7)}` : WEEKDAY_LETTERS[new Date(`${c.day}T12:00:00Z`).getUTCDay()]}
          </SvgText>
        ) : null,
      )}
      <Path d={`${g.d} L${ex},${H - PAD.bottom} L${g.x(0)},${H - PAD.bottom} Z`} fill="url(#tenfade)" />
      <Line x1={ex} x2={ex} y1={PAD.top} y2={H - PAD.bottom} stroke={colors.muted} strokeDasharray="3 4" />
      <Path d={g.d} stroke={colors.accent} strokeWidth={2.4} fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={`${g.len} ${g.len}`} strokeDashoffset={g.len * (1 - draw)} />
      <Circle cx={ex} cy={ey} r={5} fill={colors.accent} stroke={colors.surface} strokeWidth={3} />
      <Rect x={lx} y={ey - 12} width={lw} height={22} rx={11} fill={colors.accent} />
      <SvgText x={lx + lw / 2} y={ey + 3} fontSize={11} fontWeight="600" fill={colors.accentInk} textAnchor="middle" fontFamily={CHART_FONT}>
        {label}
      </SvgText>
    </Svg>
  );
}

const styles = StyleSheet.create({
  exec: { alignSelf: 'flex-start', marginTop: 10, borderWidth: 1, borderRadius: 14, paddingVertical: 7, paddingHorizontal: 12 },
  execLabel: { fontSize: 11 },
  execValue: { fontSize: 14, fontWeight: '600' },
  chart: { marginTop: 8 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  swatch: { width: 10, height: 3, borderRadius: 2 },
  legendText: { fontSize: 11.5 },
});
