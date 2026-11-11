// The shared world clock and both markets' hours on today's timeline (Israel time, 08:00-24:00).
// "Advance clock" is admin-only (DD-10, D-001): it opens the admin page scrolled to the world clock section,
// where the advance / start / stop buttons are (D-030).

import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { ClockView, MarketSession } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { dayLabel, hhmm } from '../../dashboard/format';
import { Button } from './Button';
import { Card, Empty } from './Card';
import { Chip } from './Chip';
import { ltr } from './layout';

const AXIS_START = 8 * 60;
const AXIS_END = 24 * 60;
const AXIS_LABELS = ['08:00', '12:00', '16:00', '20:00', '24:00'];

// A position on the axis, and a length of time, as a % of the axis width.
const share = (minutes: number) => `${((minutes / (AXIS_END - AXIS_START)) * 100).toFixed(2)}%` as const;
const toPct = (min: number) => share(min - AXIS_START);

export function WorldClockCard({ clock, isAdmin }: { clock: ClockView | null; isAdmin: boolean }) {
  return (
    <Card
      title="שעון העולם"
      sub="כל השחקנים חיים באותו שעון"
      end={clock ? <Chip>{`${dayLabel(clock.weekday)} · ${clock.time}`}</Chip> : null}
    >
      {clock ? (
        <View style={styles.timeline}>
          <Track city="תל אביב" market={clock.markets.tase} nowMin={minutesOf(clock.time)} />
          <Track city="ניו יורק" market={clock.markets.us} nowMin={minutesOf(clock.time)} />
          <Axis />
        </View>
      ) : (
        <Empty>שעון העולם עוד לא הופעל. מנהל המשחק מפעיל ומקדם אותו.</Empty>
      )}
      {isAdmin ? (
        <View style={styles.admin}>
          <Button
            label="קדם שעון ▸"
            small
            onPress={() => router.navigate({ pathname: '/admin-dashboard', params: { to: 'clock' } })}
            hint="מנהל בלבד. פותח את שעון העולם בדף הניהול"
          />
        </View>
      ) : null}
    </Card>
  );
}

function minutesOf(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function Track({ city, market, nowMin }: { city: string; market: MarketSession; nowMin: number }) {
  const { colors } = useTheme();
  const s = market.session;
  return (
    <View style={styles.trackRow}>
      <View style={styles.trackLabel}>
        <Text style={[styles.city, { color: colors.fg }]}>{city}</Text>
        <Text style={[styles.hours, { color: colors.muted }]}>{s ? `${hhmm(s.openMin)}–${hhmm(s.closeMin)}` : 'סגור היום'}</Text>
      </View>
      <View style={[styles.track, ltr, { backgroundColor: colors.line }]}>
        {s ? (
          <View
            style={[
              styles.session,
              { left: toPct(s.openMin), width: share(s.closeMin - s.openMin), backgroundColor: market.isOpen ? colors.accent : colors.line2 },
            ]}
          />
        ) : null}
        {nowMin >= AXIS_START ? <View style={[styles.now, { left: toPct(nowMin), backgroundColor: colors.fg }]} /> : null}
      </View>
    </View>
  );
}

function Axis() {
  const { colors } = useTheme();
  return (
    <View style={styles.axisRow}>
      <View style={styles.trackLabel} />
      <View style={[styles.axis, ltr]}>
        {AXIS_LABELS.map((l) => (
          <Text key={l} style={[styles.axisText, { color: colors.faint }]}>{l}</Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: { gap: 10, marginTop: 14, marginBottom: 14 },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  trackLabel: { width: 84 },
  city: { fontSize: 12, fontWeight: '600' },
  hours: { fontSize: 11, writingDirection: 'ltr', textAlign: 'right' },
  // The timeline runs left (08:00) to right (24:00) even in the Hebrew layout.
  track: { flex: 1, height: 6, borderRadius: 3 },
  session: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },
  now: { position: 'absolute', top: -4, bottom: -4, width: 2, borderRadius: 1 },
  axisRow: { flexDirection: 'row', gap: 12 },
  axis: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 10 },
  admin: { marginTop: 'auto', alignItems: 'flex-start' },
});
