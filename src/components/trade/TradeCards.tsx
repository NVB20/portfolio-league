// The small cards of the trading screen: the order preview (inverse card), your holding in the
// selected security, cash + dollar rate, and how an order executes.

import { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { SecurityView, UsdIlsView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { ils, ilsExact, pct } from '../../dashboard/format';
import { checkChip, checkNote } from '../../trade/copy';
import { CAP, type Check, type Side } from '../../trade/orderCheck';
import { Button } from '../dashboard/Button';
import { Card, Empty, usePalette } from '../dashboard/Card';
import { Chip } from '../dashboard/Chip';
import { ltr } from '../dashboard/layout';

const BAR_FULL_PCT = 25;   // the bar's full width is 25% of the portfolio, so the 20% cap mark sits at 80%
const NEAR_CAP_PCT = 18;

// A weight bar with a tick at the 20% cap (rule 4).
export function WeightBar({ weightPct, tone }: { weightPct: number; tone: 'ok' | 'warn' | 'bad' }) {
  const { colors } = useTheme();
  const p = usePalette();
  const fill = tone === 'bad' ? colors.neg : tone === 'warn' ? colors.warn : p.accentFill;
  const width = `${Math.min(100, (Math.max(0, weightPct) / BAR_FULL_PCT) * 100)}%` as const;
  return (
    <View style={[styles.bar, ltr, { backgroundColor: p.tone === 'inverse' ? colors.inverseTile : colors.line }]}>
      <View style={[styles.barFill, { width, backgroundColor: fill }]} />
      <View style={[styles.capMark, { backgroundColor: p.tone === 'inverse' ? colors.inverseInk : colors.faint }]} />
    </View>
  );
}

// "Before you send": what the order would do, by the latest price. The send button scrolls up to the ticket.
// A buy's weight counts this player's pending buys of the same security too, like the server's 20% check (D-028).
// A sell shows the exact units it sends (D-018). When the API's pending list was cut, the pending buys shown are
// only those it sent, so the row says 'at least'.
export function PreviewCard({ security, side, amount, check, availableCash, pendingBuysIls, usdRate, onSend }: {
  security: SecurityView;
  side: Side;
  amount: number;
  check: Check;
  availableCash: number;
  pendingBuysIls: number;
  usdRate: number | null;
  onSend: () => void;
}) {
  const chip = checkChip(check);
  const bad = !check.ok && check.status !== 'empty';
  const usd = security.currency === 'USD' && usdRate ? ` · $${(amount / usdRate).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
  const units = check.units.toLocaleString('en-US', { maximumFractionDigits: side === 'sell' ? 8 : 3 });
  return (
    <Card inverse title="לפני שאתה שולח" sub="הערכה לפי המחיר האחרון. המחיר הסופי ייקבע בביצוע." end={<Chip variant={chip.variant}>{chip.label}</Chip>}>
      <View style={styles.rows}>
        <PRow label={`${side === 'buy' ? 'קנייה' : 'מכירה'} ${security.symbol}${usd}`} value={ils(amount)} big />
        <PRow label={side === 'sell' ? 'יחידות למכירה' : 'יחידות משוערות'} value={units} />
        {side === 'buy' && pendingBuysIls > 0 ? <PRow label={check.capExact ? 'קניות ממתינות בנייר' : 'קניות ממתינות בנייר (לפחות)'} value={ilsExact(pendingBuysIls)} /> : null}
        <PRow label="מזומן זמין אחרי" value={ils(check.cashAfter)} bad={check.status === 'noCash'} />
        <PRow label="משקל בתיק אחרי" value={pct(check.weightAfterPct, { digits: 1, signed: false })} bad={check.status === 'overCap'} />
      </View>
      <WeightBar weightPct={check.weightAfterPct} tone={bad ? 'bad' : check.weightAfterPct >= NEAR_CAP_PCT ? 'warn' : 'ok'} />
      <Note left={side === 'buy' ? 'תקרה 20% ברגע הקנייה' : 'אין מכירה בחסר'} right={checkNote(check, side, amount, availableCash, security.symbol)} hot={bad} />
      <View style={styles.cardBtn}>
        <Button label={side === 'buy' ? 'שלח פקודת קנייה' : 'שלח פקודת מכירה'} variant="ink" disabled={!check.ok} onPress={onSend} />
      </View>
    </Card>
  );
}

function PRow({ label, value, big = false, bad = false }: { label: string; value: string; big?: boolean; bad?: boolean }) {
  const { colors } = useTheme();
  const p = usePalette();
  return (
    <View style={[styles.prow, { borderTopColor: p.line }]}>
      <Text style={[styles.prowLabel, { color: p.sub }]}>{label}</Text>
      <Text style={[styles.prowValue, big && styles.prowBig, { color: bad ? colors.neg : p.fg }]}>{value}</Text>
    </View>
  );
}

function Note({ left, right, hot = false }: { left: string; right: string; hot?: boolean }) {
  const { colors } = useTheme();
  const p = usePalette();
  return (
    <View style={styles.note}>
      <Text style={[styles.noteText, { color: p.sub }]}>{left}</Text>
      <Text style={[styles.noteText, { color: hot ? colors.neg : p.sub }, hot && { fontWeight: '600' }]}>{right}</Text>
    </View>
  );
}

// Your holding in the selected security: value and weight against the cap. Units already in a pending sell
// are locked, so the line says how many are free.
export function PositionCard({ security }: { security: SecurityView }) {
  const p = usePalette();
  const h = security.holding;
  const value = h?.valueIls ?? 0;
  const weight = h?.weightPct ?? 0;
  const near = weight >= NEAR_CAP_PCT;
  const n = (u: number) => u.toLocaleString('en-US', { maximumFractionDigits: 3 });
  const free = h && h.freeUnits < h.units ? ` · ${n(h.freeUnits)} פנויות` : '';
  return (
    <Card
      title="האחזקה שלך"
      sub={h ? `${n(h.units)} יחידות${free} · ${security.nameHe}` : `עדיין לא מחזיק ${security.nameHe}`}
      end={<Chip variant={near ? 'warn' : 'ghost'}>{near ? `קרוב לתקרה · ${pct(weight, { digits: 1, signed: false })}` : pct(weight, { digits: 1, signed: false })}</Chip>}
    >
      <Text style={[styles.kv, { color: p.fg }]}>{ils(value)}</Text>
      <WeightBar weightPct={weight} tone={near ? 'warn' : 'ok'} />
      <Note left={`${pct(weight, { digits: 1, signed: false })} מהתיק`} right={`תקרה ${CAP * 100}% ברגע הקנייה`} />
    </Card>
  );
}

// Available cash and the dollar rate (US securities convert at the rate at execution, not at sending).
// Cash set aside for pending buys isn't available; the note says how much (D-019). Figures are exact to the agora,
// so the card never shows more than can be spent.
export function CashCard({ cash, availableCash, totalValue, usd }: { cash: number; availableCash: number; totalValue: number; usd: UsdIlsView | null }) {
  const { colors } = useTheme();
  const cashPct = totalValue > 0 ? (availableCash / totalValue) * 100 : 100;
  const reserved = Math.max(0, cash - availableCash);
  return (
    <Card
      title="מזומן זמין"
      sub="ניירות ארה״ב מומרים לפי שער הדולר ברגע הביצוע"
      end={usd?.weekChangePct != null ? <Chip variant={usd.weekChangePct >= 0 ? 'up' : 'down'}>{`${usd.weekChangePct >= 0 ? '▲' : '▼'} ${pct(Math.abs(usd.weekChangePct), { digits: 1, signed: false })} השבוע`}</Chip> : null}
    >
      <View style={styles.tiles}>
        <Tile solid value={ilsExact(availableCash)} label={`זמין · ${pct(cashPct, { digits: 1, signed: false })} מהתיק`} />
        <Tile value={usd ? `₪${usd.rate.toFixed(3)}` : '–'} label="USD / ILS · סגירה אחרונה" color={colors.fg} />
      </View>
      {reserved >= 0.005 ? <Note left={`${ilsExact(reserved)} שמורים לקניות ממתינות`} right={`סך המזומן ${ilsExact(cash)}`} /> : null}
    </Card>
  );
}

function Tile({ value, label, solid = false, color }: { value: string; label: string; solid?: boolean; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: solid ? colors.accent : colors.surface2 }]}>
      <Text style={[styles.tileValue, { color: solid ? colors.accentInk : color ?? colors.fg }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: solid ? colors.accentInk : colors.faint }, solid && { opacity: 0.75 }]}>{label}</Text>
    </View>
  );
}

// How an order executes: the same rules for every player.
export function RulesCard() {
  return (
    <Card title="איך פקודה מתבצעת" sub="אותם כללים לכל השחקנים">
      <View style={styles.rules}>
        <Rule now icon="time-outline" title="נשלחה כשהשוק פתוח" text="מתבצעת היום בשער הסגירה. תל אביב 17:30 (יום ו׳ 13:50), ניו יורק 23:00 שעון ישראל." />
        <Rule icon="arrow-forward" title="נשלחה כשהשוק סגור" text="מתבצעת בשער הפתיחה של יום המסחר הבא." />
        <Rule icon="logo-usd" title="ניירות ארה״ב" text="נקנים בדולרים ומומרים לפי שער הדולר ברגע הביצוע, לא ברגע השליחה." />
        <Rule icon="ban-outline" title="אין ביטול, אין שורט, אין מינוף" text="ונייר אחד לא עובר 20% מהתיק ברגע הקנייה." />
      </View>
    </Card>
  );
}

function Rule({ icon, title, text, now = false }: { icon: keyof typeof Ionicons.glyphMap; title: string; text: string; now?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.rule, { borderTopColor: colors.line }]}>
      <View style={[styles.ruleIcon, { backgroundColor: now ? colors.accent : colors.surface2 }]}>
        <Ionicons name={icon} size={17} color={now ? colors.accentInk : colors.accent} />
      </View>
      <View style={styles.ruleText}>
        <Text style={[styles.ruleTitle, { color: colors.fg }]}>{title}</Text>
        <Text style={[styles.ruleBody, { color: colors.faint }]}>{text}</Text>
      </View>
    </View>
  );
}

// A card that says what will fill it.
export function EmptyCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <Card title={title} sub={sub}>
      <Empty>{children}</Empty>
    </Card>
  );
}

const styles = StyleSheet.create({
  bar: { height: 4, borderRadius: 2, marginTop: 12, position: 'relative' },
  barFill: { height: '100%', borderRadius: 2 },
  capMark: { position: 'absolute', top: -4, bottom: -4, left: '80%', width: 1 },
  rows: { marginTop: 8 },
  prow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingVertical: 9, borderTopWidth: 1 },
  prowLabel: { fontSize: 13 },
  prowValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  prowBig: { fontSize: 22 },
  note: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  noteText: { fontSize: 11.5 },
  cardBtn: { marginTop: 12 },
  kv: { fontSize: 30, fontWeight: '500', letterSpacing: -0.5, marginTop: 12, fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 12 },
  tile: { flex: 1, borderRadius: 16, padding: 14, justifyContent: 'flex-end' },
  tileValue: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tileLabel: { fontSize: 12, marginTop: 4 },
  rules: { marginTop: 8 },
  rule: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: 1 },
  ruleIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  ruleText: { flexShrink: 1 },
  ruleTitle: { fontSize: 13.5, fontWeight: '600' },
  ruleBody: { fontSize: 12.5, lineHeight: 18 },
});
