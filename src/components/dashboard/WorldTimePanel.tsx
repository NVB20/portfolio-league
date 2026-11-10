// Under the headline: the world time every player shares, as the admin runs it (D-017).
// Whether the clock runs or is stopped, the live time, what each market is doing now, and where the clock ends.
// While running, the time moves on by itself between loads (src/dashboard/liveClock.ts).

import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LiveClockView, MarketSession } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { dayLabel, hhmm } from '../../dashboard/format';
import { clockStatus, endLabel, isOpenAt, liveTime, marketLine, type ClockStatus, type LiveTime } from '../../dashboard/liveClock';

const TICK_MS = 10_000;   // minute precision is all the panel shows

const STATUS: Record<ClockStatus, { label: string; note: string }> = {
  running: { label: 'השעון רץ', note: 'הזמן בעולם זז בקצב אמיתי, לכל השחקנים יחד.' },
  stopped: { label: 'השעון עצור', note: 'מנהל המשחק עצר את הזמן. פקודות ממתינות עד שהשעון יזוז.' },
  ended: { label: 'העולם הגיע לסופו', note: 'השעון נעצר כשנגמרו המחירים.' },
};

export function WorldTimePanel({ clock }: { clock: LiveClockView | null }) {
  const { colors } = useTheme();
  const elapsed = useElapsed(clock);

  if (!clock) {
    return (
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.note, { color: colors.faint }]}>שעון העולם עוד לא הופעל. מנהל המשחק מפעיל אותו.</Text>
      </View>
    );
  }

  const t = liveTime(clock, elapsed);
  const status = clockStatus(clock, t);
  const dot = status === 'running' ? colors.accent : status === 'stopped' ? colors.warn : colors.faint;

  return (
    <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.line }]} accessibilityLabel="שעון העולם">
      <View style={styles.head}>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={[styles.statusText, { color: colors.fg }]}>{STATUS[status].label}</Text>
        </View>
        <Text style={[styles.time, { color: colors.fg }]}>
          <Text style={{ color: colors.muted }}>{`${dayLabel(t.weekday)} · `}</Text>
          {hhmm(t.minutes)}
        </Text>
      </View>

      <View style={[styles.markets, { borderColor: colors.line }]}>
        <MarketRow city="תל אביב" market={clock.markets.tase} t={t} date={clock.date} />
        <MarketRow city="ניו יורק" market={clock.markets.us} t={t} date={clock.date} />
      </View>

      <Text style={[styles.note, { color: colors.faint }]}>
        {STATUS[status].note}
        {clock.endsAt && status !== 'ended' ? ` נעצר ב־${endLabel(clock.endsAt)}.` : ''}
      </Text>
    </View>
  );
}

function MarketRow({ city, market, t, date }: { city: string; market: MarketSession; t: LiveTime; date: string }) {
  const { colors } = useTheme();
  const open = isOpenAt(market, t);
  return (
    <View style={styles.row}>
      <View style={[styles.marketDot, { backgroundColor: open ? colors.accent : colors.line2 }]} />
      <Text style={[styles.city, { color: colors.fg }]}>{city}</Text>
      <Text style={[styles.line, { color: open ? colors.accent : colors.muted }]}>{marketLine(market, t, date)}</Text>
    </View>
  );
}

// Real ms since this clock was loaded. Ticks only while the admin has the clock running.
function useElapsed(clock: LiveClockView | null): number {
  const loadedAt = useMemo(() => Date.now(), [clock]);
  const [now, setNow] = useState(loadedAt);
  useEffect(() => {
    if (!clock?.running) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [clock]);
  return Math.max(0, now - loadedAt);
}

const styles = StyleSheet.create({
  panel: { marginTop: 24, maxWidth: 420, borderWidth: 1, borderRadius: 14, padding: 16, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 14, fontWeight: '600' },
  time: { fontSize: 20, fontWeight: '300', fontVariant: ['tabular-nums'] },
  markets: { gap: 8, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  marketDot: { width: 6, height: 6, borderRadius: 3 },
  city: { fontSize: 13, fontWeight: '600', width: 64 },
  line: { fontSize: 13, flex: 1, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12.5, lineHeight: 19 },
});
