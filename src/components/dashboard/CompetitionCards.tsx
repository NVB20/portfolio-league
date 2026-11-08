// Section 3: the weekly leaderboard (top 5 + you), how your score is made, and the daily streak.

import { Animated, StyleSheet, Text, View } from 'react-native';
import type { Dashboard, StandingView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { pct, score } from '../../dashboard/format';
import { Card, Empty, usePalette } from './Card';
import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { useLoop } from './motion';

export function LeaderboardCard({ leaderboard, standing }: { leaderboard: Dashboard['leaderboard']; standing: StandingView | null }) {
  const { colors } = useTheme();
  return (
    <Card
      title="טבלת השבוע"
      sub={leaderboard.players > 0 ? `${leaderboard.players.toLocaleString('en-US')} שחקנים` : undefined}
      end={<IconButton label="פתח את הטבלה המלאה" />}
    >
      {leaderboard.top.length === 0 ? (
        <Empty>הטבלה תיפתח אחרי שהציונים הראשונים של השבוע יחושבו.</Empty>
      ) : (
        <View style={styles.rows}>
          {leaderboard.top.map((r, i) => (
            <View key={r.rank} style={[styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: colors.line }]}>
              <Text style={[styles.rank, { color: colors.faint }]}>{r.rank}</Text>
              <Text style={[styles.name, { color: r.isMe ? colors.accent : colors.fg }, r.isMe && { fontWeight: '700' }]} numberOfLines={1}>
                {r.name}
              </Text>
              <Text style={[styles.ret, { color: colors.muted }]}>{pct(r.returnPct, { digits: 1 })}</Text>
              <Text style={[styles.score, { color: colors.fg }]}>{score(r.score)}</Text>
            </View>
          ))}
        </View>
      )}
      {standing ? (
        <View style={[styles.you, { backgroundColor: colors.accent }]}>
          <View>
            <Text style={[styles.youLabel, { color: colors.accentInk }]}>המקום שלך</Text>
            <Text style={[styles.youValue, { color: colors.accentInk }]}>{`#${standing.rank}`}</Text>
          </View>
          <View>
            <Text style={[styles.youLabel, { color: colors.accentInk }]}>ציון</Text>
            <Text style={[styles.youValue, { color: colors.accentInk }]}>{score(standing.score)}</Text>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

export function ScoreBreakdownCard({ standing }: { standing: StandingView | null }) {
  const { colors } = useTheme();
  return (
    <Card
      title="איך הציון מורכב"
      sub={
        standing
          ? `0.85 × ${Math.round(standing.returnRank)} + 0.15 × ${Math.round(standing.stabilityRank)} = ${score(standing.score)}`
          : '0.85 × דירוג תשואה + 0.15 × דירוג יציבות'
      }
    >
      {standing ? (
        <View style={styles.tiles}>
          <View style={styles.tileRow}>
            <Tile value={score(standing.score)} label="הציון השבועי" solid />
            <Tile value={String(Math.round(standing.returnRank))} label="דירוג תשואה · × 0.85" />
          </View>
          <View style={styles.tileRow}>
            <Tile
              value={String(Math.round(standing.stabilityRank))}
              label="דירוג יציבות · × 0.15"
              color={standing.stabilityRank < standing.returnRank ? colors.warn : undefined}
            />
            <Tile
              value={standing.rankChange === null ? '–' : `${standing.rankChange >= 0 ? '▲' : '▼'} ${Math.abs(standing.rankChange)}`}
              label="מקומות מאתמול"
              color={standing.rankChange === null ? undefined : standing.rankChange >= 0 ? colors.accent : colors.neg}
            />
          </View>
        </View>
      ) : (
        <Empty>
          דירוג תשואה: האחוזון של התשואה השבועית שלך (100 = הכי גבוהה). דירוג יציבות: האחוזון של הירידה המקסימלית
          (100 = הירידה הקטנה ביותר).
        </Empty>
      )}
    </Card>
  );
}

function Tile({ value, label, solid = false, color }: { value: string; label: string; solid?: boolean; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: solid ? colors.accent : colors.surface2 }]}>
      <Text style={[styles.tileValue, { color: color ?? (solid ? colors.accentInk : colors.fg) }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: solid ? colors.accentInk : colors.faint }]}>{label}</Text>
    </View>
  );
}

// The retention feature isn't chosen yet (PROGRESS, phase 6), so this card is a labelled placeholder.
export function StreakCard() {
  return (
    <Card inverse title="הרצף היומי" sub="כניסה אחת ביום שומרת עליו" end={<Chip>בקרוב</Chip>}>
      <StreakBody />
    </Card>
  );
}

// No streak is counted yet, so the five day dots (Mon-Fri) are all empty.
function StreakBody() {
  const p = usePalette();
  const flicker = useLoop(1600);
  return (
    <View style={styles.streak}>
      <Animated.Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.flame,
          {
            transform: [
              { scale: flicker.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
              { rotate: flicker.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '2deg'] }) },
            ],
          },
        ]}
      >
        🔥
      </Animated.Text>
      <View style={styles.streakText}>
        <Text style={[styles.streakTitle, { color: p.fg }]}>עוד אין רצף</Text>
        <Text style={[styles.streakSub, { color: p.sub }]}>הרצף יתחיל לספור כשפיצ׳ר החזרה היומית יעלה.</Text>
      </View>
      <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {[1, 2, 3, 4, 5].map((d) => (
          <View key={d} style={[styles.dotDay, { backgroundColor: p.tile }]} />
        ))}
      </View>
      <Button label="הזכירו לי מחר" variant="ink" small disabled hint="יחובר עם פיצ׳ר החזרה היומית" />
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 9 },
  rank: { width: 22, fontSize: 12, fontWeight: '600' },
  name: { flex: 1, fontSize: 13.5 },
  ret: { fontSize: 12 },
  score: { minWidth: 38, fontSize: 14, fontWeight: '600', textAlign: 'left' },
  you: { marginTop: 'auto', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between' },
  youLabel: { fontSize: 12, opacity: 0.75 },
  youValue: { fontSize: 22, fontWeight: '600' },
  tiles: { gap: 10, marginTop: 14, flexGrow: 1 },
  tileRow: { flexDirection: 'row', gap: 10, flexGrow: 1 },
  tile: { flex: 1, borderRadius: 16, padding: 14, justifyContent: 'flex-end' },
  tileValue: { fontSize: 24, fontWeight: '600' },
  tileLabel: { fontSize: 12, marginTop: 4 },
  streak: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 14, flexWrap: 'wrap' },
  flame: { fontSize: 38 },
  streakText: { flexShrink: 1 },
  streakTitle: { fontSize: 22, fontWeight: '700' },
  streakSub: { fontSize: 12.5 },
  dots: { flexDirection: 'row', gap: 7, marginRight: 'auto' },
  dotDay: { width: 11, height: 11, borderRadius: 6 },
});
