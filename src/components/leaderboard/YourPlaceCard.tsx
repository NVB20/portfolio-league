// "המקום שלך": the inverse card of the leaderboard's first section (LD-02, DD-04). Your place, your score, the two
// ranks behind it, how far the place above is, and a button to your row in the table.
// Not on the board: says so, and in a live week how to get on: a buy that fills, at an open or a close (D-034).

import { StyleSheet, Text, View } from 'react-native';
import type { LeaderboardMe, LeaderboardView } from '../../../api/src/contract';
import { count, isoWeek, placeLine, points, unrankedLine } from '../../leaderboard/board';
import { Button } from '../dashboard/Button';
import { Card, Empty, usePalette } from '../dashboard/Card';
import { RankChangeChip, RankTile } from '../dashboard/ScoreCard';

export function YourPlaceCard({ board, onMyRow }: { board: LeaderboardView; onMyRow: () => void }) {
  const { week, me } = board;
  const sub = week ? `שבוע ${isoWeek(week.start)} · ${week.final ? 'המקום הסופי' : 'מתעדכן בכל פתיחה וסגירה'}` : 'הטבלה עוד לא נפתחה';
  return (
    <Card inverse title="המקום שלך" sub={sub} end={me?.rankChange ? <RankChangeChip change={me.rankChange} /> : null}>
      {me && week ? (
        <Placed me={me} players={board.players} final={week.final} onMyRow={onMyRow} />
      ) : (
        <Empty>{unrankedLine(week)}</Empty>
      )}
    </Card>
  );
}

function Placed({ me, players, final, onMyRow }: { me: LeaderboardMe; players: number; final: boolean; onMyRow: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.body}>
      <View>
        <View style={styles.place} accessible accessibilityLabel={`מקום ${me.rank} מתוך ${count(players)}, ציון ${points(me.score)}`}>
          <Text style={[styles.rank, { color: p.fg }]}>{`#${me.rank}`}</Text>
          <View>
            <Text style={[styles.score, { color: p.fg }]}>{points(me.score)}</Text>
            <Text style={[styles.small, { color: p.sub }]}>הציון השבועי</Text>
          </View>
          <View style={styles.of}>
            <Text style={[styles.small, { color: p.sub }]}>מתוך</Text>
            <Text style={[styles.small, { color: p.sub }]}>{count(players)}</Text>
          </View>
        </View>
        <View style={styles.tiles}>
          <RankTile value={me.returnRank} kind="return" />
          <RankTile value={me.stabilityRank} kind="stability" />
        </View>
        <Text style={[styles.next, { color: p.fg }]}>{placeLine(me, final)}</Text>
      </View>
      <View style={styles.cta}>
        <Button label="לשורה שלי בטבלה ↓" variant="ink" onPress={onMyRow} hint="מציג את המקומות סביבך בטבלה" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, justifyContent: 'space-between' },
  place: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 16, marginTop: 14 },
  rank: { fontSize: 52, fontWeight: '600', letterSpacing: -1.5, lineHeight: 56, fontVariant: ['tabular-nums'] },
  score: { fontSize: 26, fontWeight: '600', lineHeight: 28, fontVariant: ['tabular-nums'] },
  small: { fontSize: 11.5, marginTop: 3 },
  of: { flexDirection: 'row', gap: 4 },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 14 },
  next: { fontSize: 13, fontWeight: '600', marginTop: 14 },
  cta: { marginTop: 16 },
});
