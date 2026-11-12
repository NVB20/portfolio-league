// One holding: value, daily change, and its weight with a mark at the 20% cap (rule 4).
// A holding close to the cap is the inverse card of section 2 (DD-04).
// The bar's full width is 25% of the portfolio, so the 20% mark sits at 80% of the bar.
// The bar springs to its width when the card scrolls into view; the second card in a row 90ms later (DD-06).
// Its active stop losses (D-037) are listed under the bar, each with a pencil that moves it (D-041).

import { useContext, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { HoldingView } from '../../../api/src/contract';
import { fixed } from '../../theme';
import { ils, pct } from '../../dashboard/format';
import { stopNowText } from '../../trade/stopMove';
import { StopEditButton, StopEditor } from '../trade/StopEditor';
import { Card, usePalette } from './Card';
import { Chip } from './Chip';
import { ltr } from './layout';
import { ColumnContext, SeenContext, useSpring } from './motion';
import { useTheme } from '../../useTheme';

const BAR_FULL_PCT = 25;
const CAP_PCT = 20;

const EXCHANGE_NAME: Record<HoldingView['exchange'], string> = { TASE: 'תל אביב', NASDAQ: 'NASDAQ', NYSE: 'NYSE' };

// onStopMoved: load the dashboard again after a stop was moved.
export function HoldingCard({ holding, onStopMoved }: { holding: HoldingView; onStopMoved: () => void }) {
  const h = holding;
  return (
    <Card
      inverse={h.nearCap}
      title={h.nameHe}
      head={<Head holding={h} />}
      end={
        <>
          {h.nearCap ? <Chip variant="warn">קרוב לתקרה</Chip> : null}
          {h.dayChangePct !== null ? (
            <Chip variant={h.dayChangePct >= 0 ? 'up' : 'down'}>
              {`${h.dayChangePct >= 0 ? '▲' : '▼'} ${pct(Math.abs(h.dayChangePct), { digits: 1, signed: false })}`}
            </Chip>
          ) : null}
        </>
      }
    >
      <Body holding={h} onStopMoved={onStopMoved} />
    </Card>
  );
}

// Ticker pill (mint for Tel Aviv, grey for the US), then the Hebrew name and the exchange.
function Head({ holding: h }: { holding: HoldingView }) {
  const { colors } = useTheme();
  const p = usePalette();
  const us = h.currency === 'USD';
  const pill =
    p.tone === 'inverse'
      ? { backgroundColor: fixed.inverseAccent, color: fixed.inverseAccentInk }
      : us
        ? { backgroundColor: colors.surface2, color: colors.muted }
        : { backgroundColor: colors.accentTint, color: colors.accent };
  return (
    <View style={styles.headCol}>
      <Text style={[styles.ticker, { backgroundColor: pill.backgroundColor, color: pill.color }]}>{h.symbol}</Text>
      <View style={styles.nameRow}>
        <Text style={[styles.name, { color: p.fg }]}>{h.nameHe}</Text>
        <Text style={[styles.exchange, { color: p.sub }]}>{`${EXCHANGE_NAME[h.exchange]}${us ? ' · נקנה ב־$' : ''}`}</Text>
      </View>
    </View>
  );
}

function Body({ holding: h, onStopMoved }: { holding: HoldingView; onStopMoved: () => void }) {
  const p = usePalette();
  const inverse = p.tone === 'inverse';
  const [editing, setEditing] = useState<string | null>(null);   // the stop whose editor is open
  const seen = useContext(SeenContext);
  const column = useContext(ColumnContext);
  const grow = useSpring({ start: seen, delay: column * 90 });
  const fill = h.nearCap ? (inverse ? fixed.warnFill : p.warn) : p.accentFill;
  const width = h.weightPct === null ? 0 : Math.min(100, (h.weightPct / BAR_FULL_PCT) * 100 * grow);

  return (
    <>
      <Text style={[styles.value, { color: p.fg }]}>{ils(h.valueIls)}</Text>
      <View style={[styles.bar, ltr, { backgroundColor: p.line }]}>
        <View style={[styles.fill, { width: `${width}%`, backgroundColor: fill }]} />
        <View style={[styles.cap, { left: `${(CAP_PCT / BAR_FULL_PCT) * 100}%`, backgroundColor: inverse ? p.fg : p.sub }]} />
      </View>
      <View style={styles.weightRow}>
        <Text style={[styles.weight, { color: h.nearCap ? p.warn : p.sub }, h.nearCap && styles.bold]}>
          {h.weightPct === null ? '–' : `${pct(h.weightPct, { digits: 1, signed: false })} מהתיק`}
        </Text>
        <Text style={[styles.weight, { color: p.sub }]}>תקרה 20% ברגע הקנייה</Text>
      </View>
      {h.stops.map((s) => (
        <View key={s.id}>
          <View style={styles.stopRow}>
            <Ionicons name="shield-checkmark" size={12} color={p.sub} />
            <Text style={[styles.weight, styles.stopText, { color: p.sub }]}>
              {`${stopNowText(s.price, s.originalPrice, h.currency)} · ${s.units.toLocaleString('en-US', { maximumFractionDigits: 3 })} יחידות · נבדק בפתיחה ובסגירה`}
            </Text>
            {editing === s.id ? null : (
              <StopEditButton onPress={() => setEditing(s.id)} label={`הזזת סטופ ${s.price} של ${h.symbol}`} />
            )}
          </View>
          {editing === s.id ? (
            <StopEditor
              stopId={s.id}
              price={s.price}
              lastClose={h.lastClose}
              currency={h.currency}
              onMoved={onStopMoved}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  headCol: { flexShrink: 1, alignItems: 'flex-start' },
  ticker: { fontSize: 12, fontWeight: '600', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8, overflow: 'hidden' },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  name: { fontSize: 17, fontWeight: '600' },
  exchange: { fontSize: 12 },
  value: { fontSize: 30, fontWeight: '500', letterSpacing: -0.5, marginTop: 12 },
  // The bar fills left to right like the mock-up, even in the Hebrew layout.
  bar: { height: 4, borderRadius: 2, marginTop: 12 },
  fill: { height: '100%', borderRadius: 2 },
  cap: { position: 'absolute', top: -4, bottom: -4, width: 1 },
  weightRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  weight: { fontSize: 11.5 },
  bold: { fontWeight: '600' },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  stopText: { flexShrink: 1 },
});
