// The weekly score (rule 6): Score = 0.85 x return rank + 0.15 x stability rank.
// The inverse card of section 1 (DD-04). Gauge, the two ranks, and the score at the end of each day.

import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { StandingView } from '../../../api/src/contract';
import { fixed } from '../../theme';
import { score, WEEKDAY_LETTERS } from '../../dashboard/format';
import { noScoreLine, rankChangeText, rankText } from '../../leaderboard/board';
import { Card, Empty, usePalette } from './Card';
import { Button } from './Button';
import { Chip } from './Chip';
import { ltr } from './layout';
import { useSpring } from './motion';

// The gauge springs in after the score card itself has appeared in the load sequence (DD-06).
const GAUGE_DELAY = 1700;

const ARC = 'M10,60 A50,50 0 0 1 110,60';
const ARC_LENGTH = Math.PI * 50;   // half a circle of radius 50

// `finalWeek` = the board shown is a closed week (D-032: the weekend, or Monday before the open), as its ISO week
// number: the card then says the score is that week's final one, not this week's.
export function ScoreCard({ standing, todayWeekday, finalWeek = null }: {
  standing: StandingView | null;
  todayWeekday: number | null;
  finalWeek?: number | null;
}) {
  return (
    <Card
      inverse
      title="הציון השבועי"
      sub={finalWeek === null ? '85% דירוג תשואה · 15% דירוג יציבות' : `שבוע ${finalWeek} · התוצאה הסופית`}
      end={standing?.rankChange ? <RankChangeChip change={standing.rankChange} /> : null}
    >
      {standing ? (
        <>
          <Gauge value={standing.score} rank={standing.rank} players={standing.players} />
          <View style={styles.tiles}>
            <RankTile value={standing.returnRank} label="דירוג תשואה · × 0.85" dot="ink" />
            <RankTile value={standing.stabilityRank} label="דירוג יציבות · × 0.15" dot="accent" />
          </View>
          <DailyScores days={standing.days} todayWeekday={todayWeekday} />
          <View style={styles.cta}>
            <Button label="איך משפרים את היציבות ←" variant="ink" disabled hint="יחובר כשמסך ההסבר ייבנה" />
          </View>
        </>
      ) : (
        <Empty>{noScoreLine(finalWeek !== null)}</Empty>
      )}
    </Card>
  );
}

// Against the previous scored day of the week, which isn't always yesterday (LD-09).
export function RankChangeChip({ change }: { change: number }) {
  return <Chip variant={change > 0 ? 'up' : 'down'}>{rankChangeText(change)}</Chip>;
}

function Gauge({ value, rank, players }: { value: number; rank: number; players: number }) {
  const p = usePalette();
  const v = useSpring({ delay: GAUGE_DELAY });   // 0 -> ~1.07 -> 1: the arc overshoots a little, then settles
  const share = Math.max(0, Math.min(1.07, (value / 100) * v));
  const angle = Math.PI * (1 - share);
  return (
    <View style={styles.gauge}>
      <Svg width="100%" height="100%" viewBox="0 0 120 68" style={StyleSheet.absoluteFill}>
        <Path d={ARC} fill="none" stroke={p.tile} strokeWidth={11} strokeLinecap="round" />
        <Path
          d={ARC}
          fill="none"
          stroke={p.fg}
          strokeWidth={11}
          strokeLinecap="round"
          strokeDasharray={`${ARC_LENGTH * share} ${ARC_LENGTH}`}
        />
        <Circle cx={60 + 50 * Math.cos(angle)} cy={60 - 50 * Math.sin(angle)} r={5} fill={fixed.inverseAccent} stroke={p.fg} strokeWidth={3} />
      </Svg>
      <View style={styles.gaugeValue}>
        <Text style={[styles.gaugeNumber, { color: p.fg }]}>{score(value)}</Text>
        <Text style={[styles.gaugeSub, { color: p.sub }]}>{`מקום #${rank} מתוך ${players.toLocaleString('en-US')}`}</Text>
      </View>
    </View>
  );
}

// One of the two rank tiles (return / stability) with its ink or accent dot. Also on the leaderboard's "your place".
export function RankTile({ value, label, dot }: { value: number; label: string; dot: 'ink' | 'accent' }) {
  const p = usePalette();
  return (
    <View style={[styles.tile, { backgroundColor: p.tile }]}>
      <View style={styles.tileTop}>
        <View style={[styles.dot, { backgroundColor: dot === 'ink' ? p.fg : fixed.inverseAccent }]} />
        <Text style={[styles.tileValue, { color: p.fg }]}>{rankText(value)}</Text>
      </View>
      <Text style={[styles.tileLabel, { color: p.sub }]}>{label}</Text>
    </View>
  );
}

// Monday to Friday. Days with no score yet are faded; today is filled.
function DailyScores({ days, todayWeekday }: { days: StandingView['days']; todayWeekday: number | null }) {
  const p = usePalette();
  const byWeekday = new Map(days.map((d) => [d.weekday, d.score]));
  const best = days.reduce<StandingView['days'][number] | null>((b, d) => (!b || d.score > b.score ? d : b), null);

  return (
    <View style={styles.daily}>
      <View style={styles.dailyHead}>
        <Text style={[styles.dailyLabel, { color: p.sub }]}>ציון יומי</Text>
        {best ? (
          <Text style={[styles.dailyLabel, { color: p.fg, fontWeight: '600' }]}>
            {`הכי טוב השבוע: ${WEEKDAY_LETTERS[best.weekday]} · ${Math.round(best.score)}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.days}>
        {[1, 2, 3, 4, 5].map((wd) => {
          const s = byWeekday.get(wd);
          const isToday = wd === todayWeekday;
          return (
            <View
              key={wd}
              style={[styles.day, { backgroundColor: isToday ? p.fg : p.tile }, s === undefined && !isToday && { opacity: 0.45 }]}
            >
              <Text style={[styles.dayValue, { color: isToday ? p.tile : p.fg }]}>{s === undefined ? '–' : Math.round(s)}</Text>
              <Text style={[styles.dayLabel, { color: isToday ? p.tile : p.sub }]}>
                {isToday ? `${WEEKDAY_LETTERS[wd]} · היום` : WEEKDAY_LETTERS[wd]}
              </Text>
              <View style={[styles.dayBar, ltr, { backgroundColor: p.line }]}>
                <View style={{ width: `${s ?? 0}%`, height: '100%', borderRadius: 2, backgroundColor: isToday ? fixed.inverseAccent : p.fg }} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gauge: { width: '100%', maxWidth: 190, aspectRatio: 120 / 68, alignSelf: 'center', marginTop: 14 },
  gaugeValue: { position: 'absolute', left: 0, right: 0, bottom: -4, alignItems: 'center' },
  gaugeNumber: { fontSize: 34, fontWeight: '600', letterSpacing: -0.5, lineHeight: 36 },
  gaugeSub: { fontSize: 11.5, marginTop: 3 },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 22 },
  tile: { flex: 1, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 },
  tileTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tileValue: { fontSize: 20, fontWeight: '600' },
  tileLabel: { fontSize: 11.5, marginTop: 3 },
  daily: { marginTop: 14 },
  dailyHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  dailyLabel: { fontSize: 11.5 },
  days: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center' },
  dayValue: { fontSize: 16, fontWeight: '600' },
  dayLabel: { fontSize: 10.5, marginTop: 3 },
  cta: { marginTop: 14 },
  dayBar: { alignSelf: 'stretch', height: 3, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
});
