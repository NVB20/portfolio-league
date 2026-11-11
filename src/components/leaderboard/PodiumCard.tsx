// "הפודיום": the top three this week with score and weekly return, #1 in the middle on the tallest step.
// No medals or emoji (LD-08): the first step is the accent fill.

import { StyleSheet, Text, View } from 'react-native';
import type { LeaderboardRow, LeaderboardView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { pct, playersText, podiumLine, podiumOrder, PODIUM_HEIGHTS, points } from '../../leaderboard/board';
import { Card, Empty } from '../dashboard/Card';
import { Chip } from '../dashboard/Chip';
import { Avatar } from './Avatar';

export function PodiumCard({ board }: { board: LeaderboardView }) {
  const { colors } = useTheme();
  const steps = podiumOrder(board.podium);
  const gap = podiumLine(board.me, board.podium);
  const third = board.podium.find((r) => r.rank === 3);
  return (
    <Card
      title="הפודיום"
      sub="שלושת הראשונים · ציון ותשואה"
      end={board.players > 0 ? <Chip>{playersText(board.players)}</Chip> : null}
    >
      {steps.length === 0 ? (
        <Empty>הפודיום יתמלא אחרי שהציונים יחושבו.</Empty>
      ) : (
        <>
          <View style={styles.podium}>
            {steps.map((r) => (
              <Step key={r.rank} row={r} />
            ))}
          </View>
          {gap ? (
            <View style={styles.gapLine}>
              <Text style={[styles.gapText, { color: colors.faint }]}>{gap}</Text>
              {third && board.me && board.me.rank > 3 ? (
                <Text style={[styles.gapText, { color: colors.faint }]}>{`#3 · ${points(third.score)}`}</Text>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Step({ row }: { row: LeaderboardRow }) {
  const { colors } = useTheme();
  const first = row.rank === 1;
  return (
    <View
      style={styles.step}
      accessible
      accessibilityLabel={`מקום ${row.rank}: ${row.name}${row.isMe ? ' (אתה)' : ''}, ציון ${points(row.score)}, תשואה ${pct(row.returnPct)}`}
    >
      <Avatar name={row.name} avatar={row.avatar} isMe={row.isMe} size={44} />
      <Text style={[styles.name, { color: row.isMe ? colors.accent : colors.fg }]} numberOfLines={1}>
        {row.name}
      </Text>
      <Text style={[styles.score, first && styles.firstScore, { color: colors.fg }]}>{points(row.score)}</Text>
      <Chip variant={row.returnPct > 0 ? 'up' : row.returnPct < 0 ? 'down' : 'ghost'}>{pct(row.returnPct)}</Chip>
      <View
        style={[
          styles.pedestal,
          { height: PODIUM_HEIGHTS[row.rank] ?? 44, backgroundColor: first ? colors.accent : colors.surface2 },
        ]}
      >
        <Text style={[styles.pedestalText, { color: first ? colors.accentInk : colors.muted }]}>{row.rank}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  podium: { flexGrow: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 18 },
  step: { flex: 1, minWidth: 0, alignItems: 'center', gap: 6 },
  name: { fontSize: 14, fontWeight: '600', maxWidth: '100%' },
  score: { fontSize: 20, fontWeight: '600', lineHeight: 22, fontVariant: ['tabular-nums'] },
  firstScore: { fontSize: 24, lineHeight: 26 },
  pedestal: { alignSelf: 'stretch', marginTop: 8, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, alignItems: 'center', justifyContent: 'center' },
  pedestalText: { fontSize: 22, fontWeight: '700' },
  gapLine: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  gapText: { fontSize: 12 },
});
