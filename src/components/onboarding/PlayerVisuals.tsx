// The picture above each player step (src/onboarding/steps.ts, PlayerVisual): the starting cash, a world clock,
// when an order runs, the three limits, the score bar, and the closing checklist. Drawn from the step's data and
// the theme tokens only, so dark and light both work. Nothing here is interactive, and nothing is live data:
// the numbers are the example from the design.

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../useTheme';
import { ltr, useLayout } from '../dashboard/layout';
import type { PlayerVisual as Visual } from '../../onboarding/steps';

type Of<K extends Visual['kind']> = Extract<Visual, { kind: K }>;

export function PlayerVisual({ visual }: { visual: Visual }) {
  switch (visual.kind) {
    case 'welcome': return <Welcome v={visual} />;
    case 'clock': return <Clock v={visual} />;
    case 'orders': return <Orders v={visual} />;
    case 'limits': return <Limits v={visual} />;
    case 'score': return <Score v={visual} />;
    case 'ready': return <Ready v={visual} />;
  }
}

// ---------- shared bits ----------

// The navy card with a 1px edge. `padding` varies by step.
function Panel({ radius = 18, padding = 18, gap = 12, children }: { radius?: number; padding?: number; gap?: number; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderColor: colors.line2, borderWidth: 1, borderRadius: radius, padding, gap }}>
      {children}
    </View>
  );
}

// A market's state dot: filled when open, a ring when closed.
function Dot({ open }: { open: boolean }) {
  const { colors } = useTheme();
  return open ? (
    <View style={[styles.dot, { backgroundColor: colors.accent }]} />
  ) : (
    <View style={[styles.dot, { borderWidth: 1.5, borderColor: colors.faint }]} />
  );
}

function Tile({ title, text }: { title: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface2 }]}>
      <Text style={[styles.tileTitle, { color: colors.fg }]}>{title}</Text>
      <Text style={[styles.tileText, { color: colors.muted }]}>{text}</Text>
    </View>
  );
}

// ---------- 1. welcome ----------

function Welcome({ v }: { v: Of<'welcome'> }) {
  const { colors } = useTheme();
  const { width } = useLayout();
  // 46px fits a phone 390 wide; on a narrower one the amount shrinks so it never clips.
  const size = Math.min(46, Math.floor((Math.min(width, 480) - 96 - 2) / 5.8));
  return (
    <View style={styles.stack16}>
      <Text style={[styles.eyebrow, { color: colors.fg }]}>{v.eyebrow}</Text>
      <Panel radius={20} padding={24} gap={8}>
        <Text style={[styles.small, { color: colors.muted }]}>{v.cash.label}</Text>
        <Text style={[styles.amount, ltr, { color: colors.accent, fontSize: size, lineHeight: Math.round(size * 1.1) }]}>
          {v.cash.amount}
        </Text>
        <Text style={[styles.small, { color: colors.muted }]}>{v.cash.note}</Text>
      </Panel>
      <View style={styles.facts}>
        {v.facts.map((f) => (
          <View key={f.label} style={[styles.fact, { backgroundColor: colors.surface2 }]}>
            <Text style={[styles.factValue, { color: colors.fg }]}>{f.value}</Text>
            <Text style={[styles.factLabel, { color: colors.muted }]}>{f.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------- 2. the world clock ----------

function Clock({ v }: { v: Of<'clock'> }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stack12}>
      <Panel radius={20} padding={20} gap={14}>
        <Text style={[styles.small, { color: colors.muted }]}>{v.label}</Text>
        <Text style={[styles.bigTime, { color: colors.fg }]}>{v.time}</Text>
        <View style={styles.chips}>
          {v.chips.map((c) => (
            <View key={c.label} style={[styles.chip, { backgroundColor: c.open ? colors.accentTint : colors.surface2 }]}>
              <Dot open={c.open} />
              <Text style={[styles.chipText, { color: c.open ? colors.fg : colors.muted }]}>{c.label}</Text>
            </View>
          ))}
        </View>
      </Panel>
      <View style={[styles.hours, { backgroundColor: colors.surface2 }]}>
        {v.hours.map((h, i) => (
          <View key={h.market} style={[styles.hoursRow, i < v.hours.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.line2 }]}>
            <Text style={[styles.hoursMarket, { color: colors.fg }]}>{h.market}</Text>
            <Text style={[styles.hoursLines, { color: colors.muted }]}>{h.lines.join('\n')}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------- 3. when an order runs ----------

function Orders({ v }: { v: Of<'orders'> }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stack10}>
      {v.cases.map((c) => (
        <Panel key={c.label} padding={16}>
          <View style={styles.caseHead}>
            <Dot open={c.open} />
            <Text style={[styles.caseTitle, { color: c.open ? colors.accent : colors.muted }]}>{c.label}</Text>
          </View>
          <View style={styles.caseTimes}>
            <View style={[styles.time, { backgroundColor: colors.surface2 }]}>
              <Text style={[styles.timeLabel, { color: colors.muted }]}>{c.sentLabel}</Text>
              <Text style={[styles.timeValue, { color: colors.fg }]}>{c.sentAt}</Text>
            </View>
            <Ionicons name="arrow-back" size={22} color={colors.faint} />
            <View style={[styles.time, styles.timeDone, { backgroundColor: colors.accentTint }]}>
              <Text style={[styles.timeLabel, { color: colors.muted }]}>{c.doneLabel}</Text>
              <Text style={[styles.timeValue, { color: colors.fg }]}>{c.doneAt}</Text>
            </View>
          </View>
        </Panel>
      ))}
      <View style={[styles.warning, { backgroundColor: colors.warnTint }]}>
        <Ionicons name="alert-circle-outline" size={20} color={colors.warn} />
        <Text style={[styles.warningText, { color: colors.fg }]}>{v.warning}</Text>
      </View>
    </View>
  );
}

// ---------- 4. the limits ----------

function Limits({ v }: { v: Of<'limits'> }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stack10}>
      <Panel>
        <View style={styles.capHead}>
          <Text style={[styles.capTitle, { color: colors.fg }]}>{v.cap.title}</Text>
          <Text style={[styles.capValue, { color: colors.accent }]}>{v.cap.value}</Text>
        </View>
        <View style={[styles.track, { backgroundColor: colors.surface2 }]} accessible accessibilityRole="image" accessibilityLabel={v.cap.shareLabel}>
          <View style={[styles.trackFill, { width: `${Math.round(v.cap.share * 100)}%`, backgroundColor: colors.accent }]} />
        </View>
        <Text style={[styles.para, { color: colors.muted }]}>{v.cap.text}</Text>
      </Panel>
      <View style={styles.grid2}>
        {v.rules.map((r) => (
          <Tile key={r.title} title={r.title} text={r.text} />
        ))}
      </View>
    </View>
  );
}

// ---------- 5. the score ----------

function Score({ v }: { v: Of<'score'> }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stack10}>
      <Panel gap={14}>
        <Text style={[styles.small, { color: colors.muted }]}>{v.label}</Text>
        <View
          style={styles.weights}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${v.returns.pct}% ${v.returns.label}, ${v.stability.pct}% ${v.stability.label}`}
        >
          <View style={[styles.weight, { flex: v.returns.pct, backgroundColor: colors.accent }]}>
            <Text style={[styles.weightBig, { color: colors.accentInk }]}>{v.returns.pct}%</Text>
          </View>
          <View style={[styles.weight, { flex: v.stability.pct, backgroundColor: colors.avatarA }]}>
            <Text style={[styles.weightSmall, { color: colors.fg }]}>{v.stability.pct}%</Text>
          </View>
        </View>
        <View style={styles.weightLabels}>
          <Text style={[styles.weightLabel, { color: colors.accent }]}>{v.returns.label}</Text>
          <Text style={[styles.weightLabel, { color: colors.muted }]}>{v.stability.label}</Text>
        </View>
      </Panel>
      {v.parts.map((p) => (
        <View key={p.title} style={[styles.part, { backgroundColor: colors.surface2 }]}>
          <Text style={[styles.tileTitle, { color: colors.fg }]}>{p.title}</Text>
          <Text style={[styles.para, { color: colors.muted }]}>{p.text}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------- 6. ready ----------

function Ready({ v }: { v: Of<'ready'> }) {
  const { colors } = useTheme();
  return (
    <Panel padding={18} gap={0}>
      {v.items.map((item, i) => (
        <View key={item} style={[styles.check, i < v.items.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.line }]}>
          <Ionicons name="checkmark" size={20} color={colors.accent} />
          <Text style={[styles.checkText, { color: colors.fg }]}>{item}</Text>
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  stack16: { gap: 16 },
  stack12: { gap: 12 },
  stack10: { gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  small: { fontSize: 13 },
  para: { fontSize: 14, lineHeight: 22 },

  // welcome
  eyebrow: { fontSize: 15, fontWeight: '600' },
  amount: { fontWeight: '700', textAlign: 'right' },
  facts: { flexDirection: 'row', gap: 8 },
  fact: { flex: 1, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 10, gap: 2 },
  factValue: { fontSize: 18, fontWeight: '600' },
  factLabel: { fontSize: 12 },

  // clock
  bigTime: { fontSize: 34, lineHeight: 38, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 32, paddingHorizontal: 12, borderRadius: 16 },
  chipText: { fontSize: 13, fontWeight: '500' },
  hours: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 4 },
  hoursRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingVertical: 12 },
  hoursMarket: { fontSize: 14, fontWeight: '500' },
  hoursLines: { flexShrink: 1, fontSize: 13, lineHeight: 19, textAlign: 'left' },

  // orders
  caseHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  caseTitle: { fontSize: 14, fontWeight: '500' },
  caseTimes: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, gap: 2 },
  timeDone: { flex: 1 },
  timeLabel: { fontSize: 11 },
  timeValue: { fontSize: 15, fontWeight: '600' },
  warning: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14 },
  warningText: { flexShrink: 1, fontSize: 15, fontWeight: '500' },

  // limits
  capHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  capTitle: { flexShrink: 1, fontSize: 17, fontWeight: '600' },
  capValue: { fontSize: 22, fontWeight: '700' },
  track: { height: 12, borderRadius: 6, flexDirection: 'row' },
  trackFill: { height: 12, borderRadius: 6 },
  grid2: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, borderRadius: 16, padding: 16, gap: 6 },
  tileTitle: { fontSize: 16, fontWeight: '600' },
  tileText: { fontSize: 14, lineHeight: 21 },

  // score
  weights: { flexDirection: 'row', gap: 4, height: 44 },
  weight: { borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  weightBig: { fontSize: 18, fontWeight: '700' },
  weightSmall: { fontSize: 14, fontWeight: '700' },
  weightLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  weightLabel: { fontSize: 13, fontWeight: '500' },
  part: { borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, gap: 4 },

  // ready
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  checkText: { flexShrink: 1, fontSize: 15 },
});
