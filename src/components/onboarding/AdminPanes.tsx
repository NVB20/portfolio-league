// The two panes of an admin step (src/onboarding/steps.ts, AdminLeftBlock / AdminRightBlock).
// Left: the explanation, on the page color. Right: an example of what the admin will see, on the "inverse" card
// (off-white on dark, navy on light), the same one-card-of-opposite-polarity rule the dashboards follow.
// The examples are pictures, not live: the buttons in them do nothing.

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../useTheme';
import { useLayout } from '../dashboard/layout';
import type { AdminLeftBlock, AdminRightBlock } from '../../onboarding/steps';
import { ADMIN_UI } from '../../onboarding/steps';
import { TextLink } from './Buttons';

// ---------- left pane ----------

export function AdminLeft({ blocks }: { blocks: AdminLeftBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <LeftBlock key={i} block={b} />
      ))}
    </>
  );
}

function LeftBlock({ block }: { block: AdminLeftBlock }) {
  const { colors } = useTheme();
  const { width } = useLayout();
  switch (block.type) {
    case 'lead': {
      const size = { large: 17, normal: 15, small: 14 }[block.size];
      return <Text style={{ fontSize: size, lineHeight: Math.round(size * 1.6), color: colors.muted }}>{block.text}</Text>;
    }
    case 'steps':
      return (
        <View style={styles.steps}>
          {block.items.map((s, i) => (
            <View key={i} style={styles.step}>
              <View style={[styles.num, { backgroundColor: colors.accentTint }]}>
                <Text style={[styles.numText, { color: colors.fg }]}>{i + 1}</Text>
              </View>
              {s.title ? (
                <View style={styles.stepBody}>
                  <Text style={[styles.stepTitle, { color: colors.fg }]}>{s.title}</Text>
                  <Text style={[styles.stepText, { color: colors.muted }]}>{s.text}</Text>
                </View>
              ) : (
                <Text style={[styles.stepPlain, { color: colors.fg }]}>{s.text}</Text>
              )}
            </View>
          ))}
        </View>
      );
    case 'tiles':
      return (
        <View style={styles.tiles}>
          {block.items.map((t, i) => (
            <View key={i} style={[styles.tile, { backgroundColor: colors.surface }]}>
              <Text style={[styles.tileNum, { color: colors.accent }]}>{i + 1}</Text>
              <Text style={[styles.tileText, { color: colors.fg }]}>{t}</Text>
            </View>
          ))}
        </View>
      );
    case 'cards':
      // Two to a row, one on a narrow phone.
      return (
        <View style={styles.cards}>
          {block.items.map((c) => (
            <View key={c.title} style={[styles.card, { backgroundColor: colors.surface }, width < 480 && styles.cardFull]}>
              <Text style={[styles.cardTitle, { color: colors.fg }]}>{c.title}</Text>
              <Text style={[styles.cardText, { color: colors.muted }]}>{c.text}</Text>
            </View>
          ))}
        </View>
      );
  }
}

// ---------- right pane ----------

// The colors inside the inverse card. `inverseGood` is for check marks and good news: mint on navy (light theme),
// a deep green on off-white (dark theme); both reach 4.5:1 on the card and on its tiles (src/theme.ts).
function useInverse() {
  const { colors } = useTheme();
  return {
    ink: colors.inverseInk,
    muted: colors.inverseMuted,
    line: colors.inverseLine,
    tile: colors.inverseTile,
    warn: colors.inverseWarn,
    good: colors.inverseGood,
    solid: colors.inverseInk,
    solidInk: colors.inverse,
  };
}

export function AdminRight({ blocks, onRestart }: { blocks: AdminRightBlock[]; onRestart: () => void }) {
  return (
    <>
      {blocks.map((b, i) => (
        <RightBlock key={i} block={b} onRestart={onRestart} />
      ))}
    </>
  );
}

// A white (or navy) card with a thin edge: the frame of every example.
function Frame({ radius = 16, padH = 16, padV = 4, gap = 0, children }: { radius?: number; padH?: number; padV?: number; gap?: number; children: ReactNode }) {
  const c = useInverse();
  return (
    <View style={{ backgroundColor: c.tile, borderColor: c.line, borderWidth: 1, borderRadius: radius, paddingHorizontal: padH, paddingVertical: padV, gap }}>
      {children}
    </View>
  );
}

function RightBlock({ block, onRestart }: { block: AdminRightBlock; onRestart: () => void }) {
  const c = useInverse();
  switch (block.type) {
    case 'marks': {
      const tone = block.tone === 'good' ? c.good : c.warn;
      return (
        <View style={styles.marks}>
          <Text style={[styles.marksTitle, { color: tone }]}>{block.title}</Text>
          {block.items.map((item) => (
            <View key={item} style={styles.mark}>
              <Ionicons name={block.tone === 'good' ? 'checkmark' : 'close'} size={20} color={tone} style={styles.markIcon} />
              <Text style={[styles.markText, { color: c.ink }]}>{item}</Text>
            </View>
          ))}
        </View>
      );
    }
    case 'divider':
      return <View style={[styles.divider, { backgroundColor: c.line }]} />;
    case 'heading':
      return <Text accessibilityRole="header" style={[styles.heading, { color: c.ink }]}>{block.text}</Text>;
    case 'caption':
      return <Text style={[styles.caption, { color: c.muted }]}>{block.text}</Text>;
    case 'note':
      return <Text style={[styles.note, { color: c.muted }]}>{block.text}</Text>;
    case 'clockDemo':
      return (
        <Frame radius={18} padH={20} padV={20} gap={14}>
          <Text style={[styles.caption, { color: c.muted, fontWeight: '400' }]}>{block.label}</Text>
          <Text style={[styles.demoTime, { color: c.ink }]}>{block.time}</Text>
          <Text style={[styles.note, { color: c.muted }]}>{block.status}</Text>
          <View style={styles.demoButtons}>
            <View style={[styles.demoPrimary, { backgroundColor: c.solid }]}>
              <Text style={[styles.demoLabel, { color: c.solidInk }]}>{block.primary}</Text>
            </View>
            <View style={[styles.demoSecondary, { borderColor: c.muted }]}>
              <Text style={[styles.demoLabel, { color: c.ink, fontWeight: '500' }]}>{block.secondary}</Text>
            </View>
          </View>
        </Frame>
      );
    case 'summary':
      return (
        <Frame padH={18} padV={16}>
          <View style={styles.summary}>
            <Ionicons name="checkmark" size={20} color={c.good} style={styles.summaryIcon} />
            <Text style={[styles.summaryText, { color: c.ink }]}>{block.text}</Text>
          </View>
        </Frame>
      );
    case 'warnings':
      return (
        <View style={styles.warnings}>
          {block.items.map((w) => (
            <View key={w.title} style={styles.warning}>
              <Ionicons name="alert-circle-outline" size={20} color={c.warn} style={styles.summaryIcon} />
              <View style={styles.warningBody}>
                <Text style={[styles.warningTitle, { color: c.warn }]}>{w.title}</Text>
                <Text style={[styles.cardText, { color: c.muted }]}>{w.text}</Text>
              </View>
            </View>
          ))}
        </View>
      );
    case 'statusTable':
      return (
        <Frame>
          {block.rows.map((r, i) => (
            <View key={r.lead} style={[styles.statusRow, i < block.rows.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <View style={styles.statusLead}>
                {r.live ? <View style={[styles.dot, { backgroundColor: c.good }]} /> : null}
                <Text style={[styles.statusLeadText, { color: r.live ? c.good : c.ink }]}>{r.lead}</Text>
              </View>
              <Text style={[styles.statusHint, { color: c.muted }]}>{r.hint}</Text>
            </View>
          ))}
        </Frame>
      );
    case 'rows': {
      const large = block.size === 'large';
      return (
        <Frame>
          {block.items.map((item, i) => (
            <View key={item} style={[{ paddingVertical: large ? 13 : 11 }, i < block.items.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <Text style={{ fontSize: large ? 15 : 14, lineHeight: large ? 23 : 21, color: c.ink }}>{item}</Text>
            </View>
          ))}
        </Frame>
      );
    }
    case 'infoCards':
      return (
        <View style={styles.infoCards}>
          {block.items.map((card) => (
            <Frame key={card.title} padH={16} padV={14} gap={4}>
              <Text style={[styles.marksTitle, { color: c.ink }]}>{card.title}</Text>
              <Text style={[styles.cardText, { color: c.muted }]}>{card.text}</Text>
            </Frame>
          ))}
        </View>
      );
    case 'replay':
      return <TextLink label={ADMIN_UI.restart} accessibilityLabel={ADMIN_UI.restart} onPress={onRestart} color={c.good} weight="500" />;
  }
}

const styles = StyleSheet.create({
  // left
  steps: { gap: 14 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 14, fontWeight: '600' },
  stepBody: { flex: 1, gap: 2 },
  stepTitle: { fontSize: 16, fontWeight: '600' },
  stepText: { fontSize: 14, lineHeight: 22 },
  stepPlain: { flex: 1, fontSize: 15, lineHeight: 23, paddingTop: 2 },
  tiles: { gap: 8 },
  tile: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14 },
  tileNum: { width: 24, fontSize: 15, fontWeight: '600' },
  tileText: { flex: 1, fontSize: 14, lineHeight: 21 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: { flexGrow: 1, flexBasis: '47%', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, gap: 4 },
  cardFull: { flexBasis: '100%' },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardText: { fontSize: 14, lineHeight: 22 },

  // right
  marks: { gap: 12 },
  marksTitle: { fontSize: 15, fontWeight: '600' },
  mark: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  markIcon: { marginTop: 2 },
  markText: { flex: 1, fontSize: 15, lineHeight: 22 },
  divider: { height: 1 },
  heading: { fontSize: 17, fontWeight: '600' },
  caption: { fontSize: 13, fontWeight: '500' },
  note: { fontSize: 14, lineHeight: 22 },
  demoTime: { fontSize: 30, lineHeight: 33, fontWeight: '700' },
  // The two buttons share a row; when the pane is too narrow for both, the second wraps under the first.
  demoButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  demoPrimary: { flexGrow: 1, flexBasis: 120, height: 44, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  demoSecondary: { flexGrow: 1, height: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  demoLabel: { fontSize: 15, fontWeight: '600' },
  summary: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  summaryIcon: { marginTop: 3 },
  summaryText: { flex: 1, fontSize: 15, lineHeight: 24 },
  warnings: { gap: 16 },
  warning: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  warningBody: { flex: 1, gap: 2 },
  warningTitle: { fontSize: 15, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 11 },
  statusLead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusLeadText: { fontSize: 14, fontWeight: '600' },
  statusHint: { flexShrink: 1, fontSize: 13, lineHeight: 19, textAlign: 'left' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  infoCards: { gap: 14 },
});
