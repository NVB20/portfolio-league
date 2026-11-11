// "השבועות האחרונים": your finish in each of your last closed weeks, then this board's week (LD-10).
// A better finish is a taller bar, against that week's own field. The screen leaves the card out when there is
// no closed week yet.

import { StyleSheet, Text, View } from 'react-native';
import type { LeaderboardView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { bestLine, points, weekColumns } from '../../leaderboard/board';
import { Card } from '../dashboard/Card';

export function PastWeeksCard({ board }: { board: LeaderboardView }) {
  const { colors } = useTheme();
  const columns = weekColumns(board.pastWeeks, board.me, board.week);
  const best = bestLine(columns);
  return (
    <Card title="השבועות האחרונים" sub="המקום שלך בסיום כל שבוע">
      <View style={styles.weeks}>
        {columns.map((c) => (
          <View key={c.key} style={styles.week} accessible accessibilityLabel={c.a11y}>
            <Text style={[styles.rank, { color: c.current ? colors.fg : colors.muted }]}>{`#${c.rank}`}</Text>
            <Text style={[styles.score, { color: colors.faint }]}>{points(c.score)}</Text>
            <View style={styles.barArea}>
              <View style={[styles.bar, { height: `${c.height}%`, backgroundColor: c.current ? colors.accent : colors.surface2 }]} />
            </View>
            <Text style={[styles.label, { color: c.current ? colors.accent : colors.faint }, c.current && styles.labelOn]} numberOfLines={1}>
              {c.label}
            </Text>
          </View>
        ))}
      </View>
      {best ? <Text style={[styles.foot, { color: colors.faint }]}>{best}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  weeks: { flexDirection: 'row', gap: 8, height: 168, marginTop: 14 },
  week: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4 },
  rank: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  score: { fontSize: 11, fontVariant: ['tabular-nums'] },
  barArea: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', maxWidth: 48, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 4, borderBottomRightRadius: 4 },
  label: { fontSize: 11 },
  labelOn: { fontWeight: '600' },
  foot: { fontSize: 12, marginTop: 12 },
});
