// The journal's table (D-035): a header, the loaded rows and "טען עוד 20", in one card, like the leaderboard's.
// The window width picks the columns (tableColumns): wide screens show every column; tablets put the side, size and
// status detail under the stock; phones keep the stock and one outcome cell (the result of a sell, otherwise the
// status). A row opens that stock on the trading screen.
// Rows are a plain .map, not a FlatList: a vertical list inside the page's ScrollView warns and gains nothing at
// 20 to 100 rows.

import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { TradeJournalRow, TradeJournalView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { emptyLine, PAGE_SIZE, rowView, tableColumns, type Column, type RowView, type TableLayout } from '../../journal/journal';
import type { MoreState } from '../../journal/useJournal';
import { Button } from '../dashboard/Button';
import { Chip } from '../dashboard/Chip';
import { Empty } from '../dashboard/Card';
import { useLayout } from '../dashboard/layout';

type Props = {
  journal: TradeJournalView;
  loading: boolean;   // a reload or a switch is on its way: the rows dim until it lands
  more: MoreState;
  onMore: () => void;
};

export function JournalTable({ journal, loading, more, onMore }: Props) {
  const { colors } = useTheme();
  const { width } = useLayout();
  const layout = tableColumns(width);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {journal.rows.length === 0 ? (
        <View style={[styles.empty, loading && styles.dim]}>
          <Empty>{emptyLine(journal.filter, journal.period)}</Empty>
        </View>
      ) : (
        <>
          <HeaderRow layout={layout} />
          <View style={loading && styles.dim}>
            {journal.rows.map((r) => (
              <Row key={r.id} row={r} view={rowView(r, journal.clock)} layout={layout} />
            ))}
          </View>
          {journal.hasMore ? (
            <View style={[styles.foot, { paddingHorizontal: layout.padX }]}>
              {more === 'failed' ? <Text style={[styles.footLabel, { color: colors.neg }]}>לא נטען. נסו שוב.</Text> : null}
              <Button
                small
                label={more === 'loading' ? 'טוען…' : `טען עוד ${PAGE_SIZE} ↓`}
                onPress={onMore}
                disabled={more === 'loading' || loading}
                hint="מוסיף את הפקודות שנשלחו לפני אלה"
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function HeaderRow({ layout }: { layout: TableLayout }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.row, rowPadding(layout), { backgroundColor: colors.surface2, borderBottomColor: colors.line }]}
    >
      {layout.columns.map((c) => (
        <View key={c.key} style={cellBox(c)}>
          <Text style={[styles.headText, { color: colors.faint }]} numberOfLines={2}>
            {c.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Row({ row, view, layout }: { row: TradeJournalRow; view: RowView; layout: TableLayout }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={() => router.navigate(`/trade?symbol=${encodeURIComponent(row.symbol)}`)}
      accessibilityRole="button"
      accessibilityLabel={view.a11y}
      accessibilityHint="פותח את המניה במסך המסחר"
      onPointerEnter={Platform.OS === 'web' ? () => setHovered(true) : undefined}
      onPointerLeave={Platform.OS === 'web' ? () => setHovered(false) : undefined}
      style={({ pressed }) => [
        styles.row,
        styles.body,
        rowPadding(layout),
        { borderBottomColor: colors.line },
        (hovered || pressed) && { backgroundColor: colors.surface2 },
      ]}
    >
      {layout.columns.map((c) => (
        <View key={c.key} style={cellBox(c)}>
          <Cell column={c} row={row} view={view} subLine={layout.subLine} />
        </View>
      ))}
    </Pressable>
  );
}

function Cell({ column, row, view, subLine }: { column: Column; row: TradeJournalRow; view: RowView; subLine: boolean }) {
  const { colors } = useTheme();
  const sideColor = row.side === 'buy' ? colors.accent : colors.fg;
  switch (column.key) {
    case 'placed':
      return <Text style={[styles.small, { color: colors.muted }]}>{view.placed}</Text>;
    case 'stock':
      return (
        <View style={styles.stock}>
          <View style={styles.stockHead}>
            <Text style={[styles.symbol, { color: colors.fg }]}>{row.symbol}</Text>
            <Text style={[styles.name, { color: colors.faint }]} numberOfLines={1}>
              {row.nameHe}
            </Text>
          </View>
          {subLine ? (
            // Each figure is its own text run, so a ₪ amount never flips inside the Hebrew words.
            <>
              <View style={styles.subLine}>
                <Text style={[styles.sub, styles.strong, { color: sideColor }]}>{view.side}</Text>
                <Text style={[styles.sub, styles.num, { color: colors.muted }]}>{view.size}</Text>
                {view.price ? (
                  <>
                    <Text style={[styles.sub, { color: colors.faint }]}>· בשער</Text>
                    <Text style={[styles.sub, styles.num, { color: colors.faint }]}>{view.price}</Text>
                  </>
                ) : null}
              </View>
              <Text style={[styles.sub, { color: row.status === 'rejected' ? colors.neg : colors.faint }]}>{view.detail}</Text>
            </>
          ) : null}
        </View>
      );
    case 'side':
      return <Text style={[styles.cellText, styles.strong, { color: sideColor }]}>{view.side}</Text>;
    case 'size':
      return <Text style={[styles.cellText, styles.num, { color: colors.fg }]}>{view.size}</Text>;
    case 'status':
      return (
        <View style={styles.start}>
          <Chip variant={view.tone}>{view.status}</Chip>
          {/* On tablets the detail is already under the stock. */}
          {subLine ? null : <Text style={[styles.detail, { color: row.status === 'rejected' ? colors.neg : colors.faint }]}>{view.detail}</Text>}
        </View>
      );
    case 'price':
      return view.price ? (
        <View style={styles.start}>
          <Text style={[styles.cellText, styles.num, { color: colors.fg }]}>{view.price}</Text>
          {view.fx ? <Text style={[styles.detail, { color: colors.faint }]}>{view.fx}</Text> : null}
        </View>
      ) : (
        <Dash />
      );
    case 'amount':
      return view.amount ? <Text style={[styles.cellText, styles.num, { color: colors.fg }]}>{view.amount}</Text> : <Dash />;
    case 'pnl':
      return view.pnl ? (
        <View style={styles.start}>
          <Chip variant={view.pnlTone}>{view.pnl}</Chip>
        </View>
      ) : (
        <Dash />
      );
    case 'outcome':
      // Phones: the result of a filled sell; anything else shows its status.
      return (
        <View style={styles.start}>
          {view.pnl ? <Chip variant={view.pnlTone}>{view.pnl}</Chip> : <Chip variant={view.tone}>{view.status}</Chip>}
        </View>
      );
  }
}

function Dash() {
  const { colors } = useTheme();
  return <Text style={[styles.cellText, { color: colors.faint }]}>—</Text>;
}

const rowPadding = (l: TableLayout) => ({ paddingHorizontal: l.padX, paddingVertical: l.padY, gap: l.gap });
// The stock takes what the fixed columns leave; minWidth 0 lets it shrink instead of pushing the row.
const cellBox = (c: Column) => (c.width === null ? styles.flexCell : { width: c.width });

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 22, overflow: 'hidden' },
  empty: { padding: 20 },
  dim: { opacity: 0.55 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  body: { minHeight: 60 },
  headText: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.2 },
  flexCell: { flex: 1, minWidth: 0 },
  num: { fontVariant: ['tabular-nums'] },
  strong: { fontWeight: '600' },
  stock: { minWidth: 0, gap: 2 },
  stockHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 },
  // alignSelf 'flex-start' on the texts: on the web every Text gets dir="auto", so a Latin ticker or a number alone
  // would sit on the LEFT of its cell under a right-aligned Hebrew header (see LeaderboardTable).
  symbol: { fontSize: 14, fontWeight: '700', alignSelf: 'flex-start' },
  name: { fontSize: 12, flexShrink: 1 },
  subLine: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 },
  sub: { fontSize: 11.5 },
  small: { fontSize: 12.5, alignSelf: 'flex-start' },
  cellText: { fontSize: 13.5, alignSelf: 'flex-start' },
  detail: { fontSize: 11.5, marginTop: 4 },
  start: { alignItems: 'flex-start' },
  foot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 10, paddingVertical: 14 },
  footLabel: { fontSize: 12.5 },
});
