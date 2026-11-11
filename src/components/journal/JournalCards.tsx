// The journal's first section (D-035): the success rate on the inverse card (DD-04: the one thing to look at), and
// the results beside it as four tiles, like the leaderboard's score breakdown. Every number is the API's.

import { StyleSheet, Text, View } from 'react-native';
import type { TradeJournalView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { count, ils, periodWord, rate, signedIls, winLossLine } from '../../journal/journal';
import { Card, Empty, usePalette } from '../dashboard/Card';

export function SuccessCard({ journal }: { journal: TradeJournalView }) {
  const s = journal.stats;
  return (
    <Card inverse title="אחוז הצלחה" sub={`מכירות ברווח מתוך המכירות · ${periodWord(journal.period)}`}>
      {s.winRatePct === null ? (
        <Empty>
          {s.even > 0
            ? `${winLossLine(s)}. אחוז ההצלחה נספר ממכירות ברווח או בהפסד.`
            : 'אחוז ההצלחה יופיע אחרי המכירה הראשונה. קנייה נספרת רק כשמוכרים אותה.'}
        </Empty>
      ) : (
        <Rate pct={s.winRatePct} wins={s.wins} losses={s.losses} line={winLossLine(s)} />
      )}
    </Card>
  );
}

function Rate({ pct, wins, losses, line }: { pct: number; wins: number; losses: number; line: string }) {
  const p = usePalette();
  return (
    <View style={styles.body} accessible accessibilityLabel={`אחוז הצלחה ${rate(pct)}. ${line}.`}>
      <Text style={[styles.rate, { color: p.fg }]}>{rate(pct)}</Text>
      {/* Wins first: in a right-to-left row they start on the right, like the sentence under them. */}
      <View style={[styles.bar, { backgroundColor: p.tile }]}>
        {wins > 0 ? <View style={{ flex: wins, backgroundColor: p.accentFill }} /> : null}
        {losses > 0 ? <View style={{ flex: losses, backgroundColor: p.down }} /> : null}
      </View>
      <Text style={[styles.line, { color: p.fg }]}>{line}</Text>
    </View>
  );
}

export function ResultsCard({ journal }: { journal: TradeJournalView }) {
  const { colors } = useTheme();
  const s = journal.stats;
  const tone = (v: number | null) => (v === null || v === 0 ? undefined : v > 0 ? colors.accent : colors.neg);
  const pending = journal.counts.pending;
  return (
    <Card title="תוצאות" sub={`מכירות שבוצעו · ${periodWord(journal.period)}`}>
      <View style={styles.tiles}>
        <View style={styles.tileRow}>
          <Tile value={signedIls(s.realizedPnlIls)} label="רווח ממומש" color={tone(s.realizedPnlIls)} />
          <Tile value={count(pending)} label={journal.reservedCash > 0 ? `ממתינות · ${ils(journal.reservedCash)} שמורים לקנייה` : 'ממתינות לביצוע'} />
        </View>
        <View style={styles.tileRow}>
          <Tile value={s.avgWinIls === null ? '—' : signedIls(s.avgWinIls)} label="רווח ממוצע למכירה" color={tone(s.avgWinIls)} />
          <Tile value={s.avgLossIls === null ? '—' : signedIls(s.avgLossIls)} label="הפסד ממוצע למכירה" color={tone(s.avgLossIls)} />
        </View>
      </View>
    </Card>
  );
}

// A tile is half a card wide, so a long figure (+₪12,340.50) gets a smaller size instead of breaking onto a second
// line, as on the trading screen's cash tiles.
const tileSize = (value: string) => (value.length <= 8 ? 24 : value.length <= 10 ? 20 : 16);

// One number and its label on a rounded tile: the score breakdown's tile (CompetitionCards), so the two cards match.
function Tile({ value, label, color }: { value: string; label: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface2 }]}>
      <Text style={[styles.tileValue, { fontSize: tileSize(value), color: color ?? colors.fg }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: colors.faint }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, justifyContent: 'flex-end', marginTop: 14 },
  tile: { flex: 1, borderRadius: 16, padding: 14, justifyContent: 'flex-end', minWidth: 0 },
  tileValue: { fontWeight: '600', fontVariant: ['tabular-nums'], alignSelf: 'flex-start' },
  tileLabel: { fontSize: 12, marginTop: 4 },
  rate: { fontSize: 52, fontWeight: '600', letterSpacing: -1.5, lineHeight: 56, fontVariant: ['tabular-nums'] },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 14 },
  line: { fontSize: 13, fontWeight: '600', marginTop: 12 },
  tiles: { gap: 10, marginTop: 14, flexGrow: 1 },
  tileRow: { flexDirection: 'row', gap: 10, flexGrow: 1 },
});
