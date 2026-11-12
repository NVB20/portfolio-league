// The cards of the rules page (src/howToPlay/content.ts, RuleCard). Text cards on the card color, and the one
// inverse card per section (DD-04) with a picture on top: a big number, a share bar, the score's two weights, or
// the drawdown example. Colors come from usePalette(), so everything flips with the card and the theme (DD-11).
// Bars fill left to right, like the holding cards' 20% bar, and spring in once their row has been seen (DD-06).

import { useContext } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RuleCard } from '../../howToPlay/content';
import { fixed } from '../../theme';
import { Card, usePalette } from '../dashboard/Card';
import { ltr } from '../dashboard/layout';
import { ColumnContext, SeenContext, useSpring } from '../dashboard/motion';

export function RuleCardView({ card }: { card: RuleCard }) {
  if (card.kind === 'text') {
    return (
      <Card title={card.title} sub={card.sub}>
        <Lines lines={card.lines} />
      </Card>
    );
  }
  return (
    <Card inverse title={card.title} sub={card.sub}>
      {card.kind === 'fact' ? <Fact value={card.value} share={card.share} /> : null}
      {card.kind === 'weights' ? <Weights parts={card.parts} /> : null}
      {card.kind === 'drop' ? <Drop points={card.points} result={card.result} /> : null}
      <Lines lines={card.lines} />
    </Card>
  );
}

function Lines({ lines }: { lines: string[] }) {
  const p = usePalette();
  return (
    <View style={styles.lines}>
      {lines.map((line, i) => (
        <Text key={i} style={[styles.line, { color: p.body }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

// 0 → ~1.07 → 1 once the row is on screen; the second card of a row starts a beat later.
function useGrow(): number {
  const seen = useContext(SeenContext);
  const column = useContext(ColumnContext);
  return useSpring({ start: seen, delay: column * 90 });
}

function Fact({ value, share }: { value?: string; share?: { value: number; label: string } }) {
  const p = usePalette();
  const grow = useGrow();
  return (
    <>
      {value ? <Text style={[styles.value, ltr, { color: p.fg }]}>{value}</Text> : null}
      {share ? (
        <>
          <View style={[styles.bar, ltr, { backgroundColor: p.line }]}>
            <View style={[styles.fill, { width: `${Math.min(100, share.value * 100 * grow)}%`, backgroundColor: p.accentFill }]} />
          </View>
          <Text style={[styles.caption, { color: p.sub }]}>{share.label}</Text>
        </>
      ) : null}
    </>
  );
}

// The score's two weights: return with an ink bar, stability with a mint one (the same pair as the rank tiles' dots).
function Weights({ parts }: { parts: { pct: number; label: string }[] }) {
  const p = usePalette();
  const grow = useGrow();
  return (
    <View style={styles.weights}>
      {parts.map((part, i) => (
        <View key={part.label}>
          <View style={styles.weightHead}>
            <Text style={[styles.weightLabel, { color: p.fg }]}>{part.label}</Text>
            <Text style={[styles.weightPct, ltr, { color: p.fg }]}>{`${part.pct}%`}</Text>
          </View>
          <View style={[styles.bar, ltr, { backgroundColor: p.line }]}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, part.pct * grow)}%`, backgroundColor: i === 0 ? p.fg : fixed.inverseAccent },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

// Three moments of a week (start, peak, the low after it), then the drop between the last two.
function Drop({ points, result }: { points: { day: string; value: string; note: string }[]; result: string }) {
  const p = usePalette();
  return (
    <>
      <View style={styles.points}>
        {points.map((pt) => (
          <View key={pt.day} style={[styles.point, { backgroundColor: p.tile }]}>
            <Text style={[styles.pointDay, { color: p.sub }]}>{pt.day}</Text>
            <Text style={[styles.pointValue, ltr, { color: p.fg }]}>{pt.value}</Text>
            <Text style={[styles.pointNote, { color: p.sub }]}>{pt.note}</Text>
          </View>
        ))}
      </View>
      <View style={styles.result}>
        <Text style={[styles.value, styles.resultValue, ltr, { color: p.down }]}>{result}</Text>
        <Text style={[styles.caption, { color: p.sub }]}>הירידה המקסימלית של השבוע</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  lines: { gap: 8, marginTop: 12 },
  line: { fontSize: 14, lineHeight: 21 },
  // The same big number as a holding card's value. alignSelf: the ltr box hugs its text at the card's start.
  value: { fontSize: 30, fontWeight: '500', letterSpacing: -0.5, marginTop: 12, alignSelf: 'flex-start' },
  bar: { height: 4, borderRadius: 2, marginTop: 12, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  caption: { fontSize: 11.5, marginTop: 6 },
  weights: { gap: 14, marginTop: 14 },
  weightHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  weightLabel: { fontSize: 13.5, fontWeight: '500' },
  weightPct: { fontSize: 20, fontWeight: '600' },
  points: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  point: { flexGrow: 1, flexBasis: 90, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 10 },
  pointDay: { fontSize: 11.5 },
  pointValue: { fontSize: 15, fontWeight: '600', marginTop: 3, alignSelf: 'flex-start' },
  pointNote: { fontSize: 11.5, marginTop: 3 },
  result: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 },
  resultValue: { marginTop: 10 },
});
