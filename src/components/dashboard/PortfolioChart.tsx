// "You vs. the median player": your portfolio value this week against the median player's,
// with the weekly return and max drawdown chips (rule 6: the score uses both).
// Underneath, small: the cash a new buy can spend, and the cash pending buys hold (D-031: stored values).
// The x-axis is the week in time (Monday 00:00 -> Saturday 00:00 Israel), so gaps in the data look like gaps.
//
// Load sequence (DD-06), ms after the page appears: your line draws 500-1500 (the median 600-1600),
// the area under it fades in at 1100, the "now" line, end dot and value label at 1300,
// the two chips pop in at 1300 and 1450 and then float gently.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import type { Point, PortfolioView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { ils, pct, WEEKDAY_LETTERS } from '../../dashboard/format';
import { cashFigures } from '../../dashboard/copy';
import { Card, Empty } from './Card';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { CHART_FONT, ltr } from './layout';
import { useLoop, useReduce, useTween } from './motion';

const W = 680;
const H = 230;
const PAD = { left: 48, right: 96, top: 22, bottom: 26 };   // right: room for the value label at the end
const DAY_MS = 86_400_000;
const WEEK_DAYS = 5;   // Monday to Friday
const FLOAT_MIN_WIDTH = 520;   // narrower charts show the chips above the chart instead of over it

type Props = { portfolio: PortfolioView; weekStartAt: string | null; nowAt: string | null };

export function PortfolioChartCard({ portfolio, weekStartAt, nowAt }: Props) {
  const { colors } = useTheme();
  const { series, medianSeries, weekReturnPct, maxDrawdownPct, vsMedianPct } = portfolio;
  const hasData = series.length > 0 && weekStartAt !== null && nowAt !== null;
  const [width, setWidth] = useState(0);
  const floating = width >= FLOAT_MIN_WIDTH;

  const chips = (
    <>
      <Float label="תשואה שבועית" value={weekReturnPct} tone="up" floating={floating} at={{ left: '62%', top: '4%' }} delay={1300} phase={0} />
      <Float
        label="ירידה מקסימלית"
        value={maxDrawdownPct === null ? null : -maxDrawdownPct}
        tone="down"
        floating={floating}
        at={{ left: '68%', top: '46%' }}
        delay={1450}
        phase={0.5}
      />
    </>
  );

  return (
    <Card
      title="אתה מול חציון השחקנים"
      sub="שווי התיק משני עד עכשיו"
      end={
        <>
          {vsMedianPct !== null ? <Chip variant={vsMedianPct >= 0 ? 'up' : 'down'}>{pct(vsMedianPct)}</Chip> : null}
          <IconButton label="פתח את גרף התיק" />
        </>
      }
    >
      {hasData ? (
        <>
          {!floating ? <View style={styles.chipsRow}>{chips}</View> : null}
          <View style={[styles.chart, ltr]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
            {width > 0 ? <Chart width={width} series={series} median={medianSeries} weekStartAt={weekStartAt} nowAt={nowAt} /> : null}
            {floating ? chips : null}
          </View>
          <View style={styles.legend}>
            <LegendItem color={colors.accent} label="אתה" />
            <LegendItem color={colors.faint} label="חציון" />
          </View>
        </>
      ) : (
        <Empty>הגרף יתמלא כשהשעון יתקדם ושווי התיק יירשם לאורך השבוע.</Empty>
      )}
      <View style={[styles.cash, { borderTopColor: colors.line }]}>
        {cashFigures(portfolio).map((f) => (
          <View key={f.label} style={styles.cashItem}>
            <Text style={[styles.cashLabel, { color: colors.faint }]}>{f.label}</Text>
            <Text style={[styles.cashValue, { color: colors.muted }]}>{f.value}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// A chip with an icon. Over the chart it pops in, then bobs up and down (6s); above the chart it stays still.
function Float({ label, value, tone, floating, at, delay, phase }: {
  label: string;
  value: number | null;
  tone: 'up' | 'down';
  floating: boolean;
  at: { left: `${number}%`; top: `${number}%` };
  delay: number;
  phase: number;
}) {
  const { colors } = useTheme();
  const reduce = useReduce();
  const pop = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const bob = useLoop(6000, phase);

  useEffect(() => {
    if (reduce) return pop.setValue(1);
    const a = Animated.timing(pop, { toValue: 1, duration: 500, delay, easing: Easing.bezier(0.2, 0.9, 0.3, 1.25), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [pop, delay, reduce]);

  const color = value === null ? colors.faint : tone === 'down' || value < 0 ? colors.neg : colors.accent;
  const iconBg = tone === 'down' ? colors.neg : colors.accent;
  const iconFg = tone === 'down' ? '#FFFFFF' : colors.accentInk;

  return (
    <Animated.View
      style={[
        styles.float,
        { backgroundColor: colors.surface2, borderColor: colors.line2 },
        floating && [styles.floating, at],
        {
          opacity: pop,
          transform: [
            { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
            ...(floating ? [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] : []),
          ],
        },
      ]}
    >
      <View style={[styles.floatIcon, { backgroundColor: iconBg }]}>
        <Text style={[styles.floatIconText, { color: iconFg }]}>{tone === 'up' ? '↗' : '↘'}</Text>
      </View>
      <View>
        <Text style={[styles.floatLabel, { color: colors.faint }]}>{label}</Text>
        <Text style={[styles.floatValue, { color }]}>{value === null ? '–' : pct(value)}</Text>
      </View>
    </Animated.View>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <Text style={[styles.legendText, { color: colors.faint }]}>{label}</Text>
    </View>
  );
}

type XY = [number, number];

// Total length of a polyline, so a dash as long as the line can "draw" it by sliding its offset to 0.
function lengthOf(pts: XY[]) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

const toPath = (pts: XY[]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function Chart({ width, series, median, weekStartAt, nowAt }: { width: number; series: Point[]; median: Point[]; weekStartAt: string; nowAt: string }) {
  const { colors } = useTheme();
  const youDraw = useTween({ delay: 500, duration: 1000 });
  const medDraw = useTween({ delay: 600, duration: 1000 });
  const area = useTween({ delay: 1100, duration: 600 });
  const late = useTween({ delay: 1300, duration: 350 });

  const g = useMemo(() => {
    const start = Date.parse(weekStartAt);
    const now = Date.parse(nowAt);
    const all = [...series, ...median].map((p) => p.value);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = Math.max((hi - lo) * 0.15, hi * 0.002);   // never a flat zero-height range
    lo -= pad;
    hi += pad;
    // Clamped to Mon-Fri: a snapshot or "now" on the weekend (the admin moved the clock past Friday)
    // sits at the right edge of the plot instead of in the label margin.
    const share = (t: number) => Math.max(0, Math.min(1, (t - start) / (WEEK_DAYS * DAY_MS)));
    const x = (t: number) => PAD.left + (W - PAD.left - PAD.right) * share(t);
    const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - (v - lo) / (hi - lo));
    const pts = (s: Point[]) => s.map((p): XY => [x(Date.parse(p.at)), y(p.value)]);
    const you = pts(series);
    const med = pts(median);
    return { start, now, x, y, you, med, youLen: lengthOf(you), medLen: lengthOf(med), ticks: [0, 1, 2, 3].map((i) => lo + ((hi - lo) * (i + 0.5)) / 4) };
  }, [series, median, weekStartAt, nowAt]);

  const [ex, ey] = g.you[g.you.length - 1];
  const bottom = H - PAD.bottom;

  return (
    <Svg width={width} height={(width * H) / W} viewBox={`0 0 ${W} ${H}`}>
      <Defs>
        <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.25} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {g.ticks.map((v) => (
        <G key={v}>
          <Line x1={PAD.left} x2={W - PAD.right} y1={g.y(v)} y2={g.y(v)} stroke={colors.line} />
          <SvgText fontFamily={CHART_FONT} x={PAD.left - 8} y={g.y(v) + 4} textAnchor="end" fontSize={11} fill={colors.faint}>
            {(v / 1e6).toFixed(2)}M
          </SvgText>
        </G>
      ))}
      {WEEKDAY_LETTERS.slice(1, 1 + WEEK_DAYS).map((d, i) => {
        const mid = g.start + (i + 0.5) * DAY_MS;
        return (
          <SvgText fontFamily={CHART_FONT} key={d} x={g.x(mid)} y={H - 6} textAnchor="middle" fontSize={11} fill={colors.faint} opacity={mid > g.now ? 0.4 : 1}>
            {d}
          </SvgText>
        );
      })}
      {g.you.length > 1 && (
        <Path d={`${toPath(g.you)} L${ex.toFixed(1)},${bottom} L${g.you[0][0].toFixed(1)},${bottom} Z`} fill="url(#fade)" opacity={area} />
      )}
      <Line x1={g.x(g.now)} x2={g.x(g.now)} y1={PAD.top} y2={bottom} stroke={colors.muted} strokeDasharray="3 4" opacity={late} />
      {g.med.length > 1 && (
        <Path
          d={toPath(g.med)}
          fill="none"
          stroke={colors.faint}
          strokeWidth={1.5}
          strokeDasharray={`${g.medLen} ${g.medLen}`}
          strokeDashoffset={g.medLen * (1 - medDraw)}
          opacity={medDraw > 0 ? 1 : 0}
        />
      )}
      {g.you.length > 1 && (
        <Path
          d={toPath(g.you)}
          fill="none"
          stroke={colors.accent}
          strokeWidth={2.4}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={`${g.youLen} ${g.youLen}`}
          strokeDashoffset={g.youLen * (1 - youDraw)}
          opacity={youDraw > 0 ? 1 : 0}
        />
      )}
      <G opacity={late}>
        <Circle cx={ex} cy={ey} r={5} fill={colors.accent} stroke={colors.surface} strokeWidth={3} />
        <Rect x={ex + 10} y={ey - 12} width={84} height={22} rx={11} fill={colors.accent} />
        <SvgText fontFamily={CHART_FONT} x={ex + 52} y={ey + 3} textAnchor="middle" fontSize={11} fontWeight="600" fill={colors.accentInk}>
          {ils(series[series.length - 1].value)}
        </SvgText>
        {g.med.length > 0 ? (
          <SvgText fontFamily={CHART_FONT} x={ex + 10} y={g.med[g.med.length - 1][1] + 14} fontSize={11} fill={colors.faint}>
            חציון
          </SvgText>
        ) : null}
      </G>
    </Svg>
  );
}

const styles = StyleSheet.create({
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chart: { marginTop: 8 },
  float: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 16, paddingVertical: 9, paddingLeft: 13, paddingRight: 11 },
  floating: { position: 'absolute', zIndex: 2, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 14 }, elevation: 6 },
  floatIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  floatIconText: { fontSize: 16, fontWeight: '700' },
  floatLabel: { fontSize: 11 },
  floatValue: { fontSize: 14.5, fontWeight: '600' },
  legend: { flexDirection: 'row', gap: 12, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch: { width: 10, height: 3, borderRadius: 2 },
  legendText: { fontSize: 11.5 },
  cash: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 6, marginTop: 14, paddingTop: 12, borderTopWidth: 1 },
  cashItem: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  cashLabel: { fontSize: 11.5 },
  cashValue: { fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
