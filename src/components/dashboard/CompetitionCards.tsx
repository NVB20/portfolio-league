// Section 3: the daily streak, the weekly leaderboard (top 5 + you), and how your score is made.

import { Animated, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Dashboard, StandingView, StreakView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { pct, score } from '../../dashboard/format';
import { streakLine, streakTitle, weekDots, weekLabel } from '../../dashboard/streak';
import { rankDelta, rankText, rankTip, scoreEquation, scoreTip, type Tip } from '../../leaderboard/board';
import { Card, Empty, usePalette } from './Card';
import { IconButton } from './IconButton';
import { InfoTip } from './InfoTip';
import { useLoop } from './motion';

export function LeaderboardCard({ leaderboard, standing }: { leaderboard: Dashboard['leaderboard']; standing: StandingView | null }) {
  const { colors } = useTheme();
  return (
    <Card
      title="טבלת השבוע"
      sub={leaderboard.players > 0 ? `${leaderboard.players.toLocaleString('en-US')} שחקנים` : undefined}
      end={<IconButton label="פתח את הטבלה המלאה" onPress={() => router.navigate('/leaderboard')} />}
    >
      {leaderboard.top.length === 0 ? (
        <Empty>הטבלה תיפתח אחרי שהציונים הראשונים של השבוע יחושבו.</Empty>
      ) : (
        <View style={styles.rows}>
          {/* The place is unique on a board (no shared places, D-032), so it is the row's key. */}
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
  // The same arrow as the table's row (no change = "–", not "▲ 0"), against the previous scored day of the week.
  const delta = standing ? rankDelta(standing.rankChange) : null;
  return (
    <Card
      title="איך הציון מורכב"
      sub={
        standing
          ? scoreEquation(standing.returnRank, standing.stabilityRank, standing.score)
          : '0.85 × דירוג תשואה + 0.15 × דירוג יציבות'
      }
    >
      {standing && delta ? (
        <View style={styles.tiles}>
          <View style={styles.tileRow}>
            <Tile
              value={score(standing.score)}
              label="הציון השבועי"
              solid
              tip={scoreTip(standing.returnRank, standing.stabilityRank, standing.score)}
            />
            <Tile value={rankText(standing.returnRank)} label="דירוג תשואה · 85%" tip={rankTip('return', standing.returnRank)} />
          </View>
          <View style={styles.tileRow}>
            <Tile
              value={rankText(standing.stabilityRank)}
              label="דירוג יציבות · 15%"
              color={standing.stabilityRank < standing.returnRank ? colors.warn : undefined}
              tip={rankTip('stability', standing.stabilityRank)}
            />
            <Tile
              value={delta.text}
              label="מקומות מהיום הקודם"
              color={delta.tone === 'up' ? colors.accent : delta.tone === 'down' ? colors.neg : colors.faint}
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

// With a `tip`, a tap explains the tile right beside it (InfoTip).
function Tile({ value, label, solid = false, color, tip }: { value: string; label: string; solid?: boolean; color?: string; tip?: Tip }) {
  const { colors } = useTheme();
  const style = [styles.tile, { backgroundColor: solid ? colors.accent : colors.surface2 }];
  const body = (
    <>
      <Text style={[styles.tileValue, { color: color ?? (solid ? colors.accentInk : colors.fg) }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: solid ? colors.accentInk : colors.faint }]}>{label}</Text>
    </>
  );
  return tip ? (
    <InfoTip tip={tip} label={`${label}: ${value}`} style={style} markColor={solid ? colors.accentInk : undefined}>
      {body}
    </InfoTip>
  ) : (
    <View style={style}>{body}</View>
  );
}

// The daily streak (D-039): real days in a row on which the player was in the app, and this real week, Sunday to
// Saturday. The API counts the days (the dashboard's own read counts today); the card only shows them.
export function StreakCard({ streak }: { streak: StreakView }) {
  return (
    <Card inverse title="הרצף היומי" sub="כניסה אחת ביום שומרת עליו">
      <StreakBody streak={streak} />
    </Card>
  );
}

function StreakBody({ streak }: { streak: StreakView }) {
  const p = usePalette();
  const flicker = useLoop(1600);
  return (
    <View style={styles.streak}>
      <Animated.Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.flame,
          { opacity: streak.days > 0 ? 1 : 0.35 },
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
        <Text style={[styles.streakTitle, { color: p.fg }]}>{streakTitle(streak)}</Text>
        <Text style={[styles.streakSub, { color: p.sub }]}>{streakLine(streak)}</Text>
      </View>
      <View style={styles.week} accessible accessibilityLabel={weekLabel(streak)}>
        {weekDots(streak).map((d) => (
          <View key={d.letter} style={styles.weekDay}>
            <View
              style={[
                styles.dotDay,
                d.state === 'in' && { backgroundColor: p.accentFill },
                (d.state === 'missed' || d.state === 'today') && { backgroundColor: p.tile },
                d.state === 'future' && { borderWidth: 1, borderColor: p.line },
                d.isToday && { borderWidth: 2, borderColor: p.fg },
              ]}
            />
            <Text style={[styles.dayLetter, { color: d.isToday ? p.fg : p.sub }]}>{d.letter}</Text>
          </View>
        ))}
      </View>
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
  week: { flexDirection: 'row', gap: 8, marginRight: 'auto' },
  weekDay: { alignItems: 'center', gap: 4 },
  dotDay: { width: 14, height: 14, borderRadius: 7 },
  dayLetter: { fontSize: 11, fontWeight: '600' },
});
