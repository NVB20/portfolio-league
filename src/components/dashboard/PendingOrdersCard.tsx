// Pending orders (rule 3): an order runs at today's close (sent while open) or the next open (sent
// while closed), and can't be cancelled. Shows the 2 that run first, plus how many more (DD-07). A buy that
// carries a stop loss says so (D-037).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Dashboard, OrderView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { dayLabel, orderSize } from '../../dashboard/format';
import { stopText } from '../../trade/copy';
import { Card, Empty } from './Card';
import { Chip } from './Chip';

type Props = { orders: Dashboard['pendingOrders']; today: string | null };

const toJournal = () => router.navigate('/journal?filter=pending');

export function PendingOrdersCard({ orders, today }: Props) {
  const { colors } = useTheme();
  const more = orders.total - orders.next.length;
  return (
    <Card
      title="פקודות ממתינות"
      sub="פקודה שנשלחה לא ניתנת לביטול"
      end={orders.total > 0 ? <Chip>{String(orders.total)}</Chip> : null}
    >
      {orders.total === 0 ? (
        <Empty>אין פקודות ממתינות. פקודה חדשה תופיע כאן עד שתבוצע.</Empty>
      ) : (
        <>
          <View style={styles.list}>
            {orders.next.map((o) => (
              <OrderRow key={o.id} order={o} today={today} />
            ))}
          </View>
          <View style={styles.footer}>
            <Text style={[styles.more, { color: colors.faint }]}>
              {more === 0 ? '' : more === 1 ? 'עוד פקודה אחת ממתינה' : `עוד ${more} פקודות ממתינות`}
            </Text>
            {/* The journal, on its waiting orders (D-035). */}
            <Pressable onPress={toJournal} accessibilityRole="link" hitSlop={8}>
              <Text style={[styles.link, { color: colors.accent }]}>ליומן ←</Text>
            </Pressable>
          </View>
        </>
      )}
    </Card>
  );
}

function OrderRow({ order, today }: { order: OrderView; today: string | null }) {
  const { colors } = useTheme();
  const buy = order.side === 'buy';
  const when = order.executesAt.date === today ? 'היום' : dayLabel(order.executesAt.weekday);
  const how = order.priceType === 'open' ? 'נשלחה כשהשוק סגור · שער פתיחה' : 'נשלחה בזמן המסחר · שער סגירה';
  const city = order.market === 'TASE' ? 'תל אביב' : 'ניו יורק';
  const size = orderSize(order);   // a buy is a ₪ amount; a sell a number of units (D-018)

  return (
    <View style={[styles.row, { backgroundColor: colors.surface2 }]}>
      <View style={[styles.when, { backgroundColor: buy ? colors.accent : colors.inverse }]}>
        <Text style={[styles.whenDay, { color: buy ? colors.accentInk : colors.inverseInk }]}>{when}</Text>
        <Text style={[styles.whenTime, { color: buy ? colors.accentInk : colors.inverseInk }]}>{order.executesAt.time}</Text>
      </View>
      <View style={styles.what}>
        <Text style={[styles.title, { color: colors.fg }]}>
          {`${buy ? 'קנייה' : 'מכירה'} ${order.symbol}${size ? ` · ${size}` : ''}${order.stopPrice !== null ? ` · ${stopText(order.stopPrice, order.market === 'US' ? 'USD' : 'ILS')}` : ''}`}
        </Text>
        <Text style={[styles.detail, { color: colors.faint }]}>{`${how} · ${city}`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, paddingVertical: 8, paddingHorizontal: 10 },
  when: { width: 52, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  whenDay: { fontSize: 10, fontWeight: '600' },
  whenTime: { fontSize: 13, fontWeight: '700' },
  what: { flexShrink: 1 },
  title: { fontSize: 13, fontWeight: '600' },
  detail: { fontSize: 11.5 },
  footer: { marginTop: 'auto', paddingTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  more: { fontSize: 12.5 },
  link: { fontSize: 12.5, fontWeight: '600' },
});
