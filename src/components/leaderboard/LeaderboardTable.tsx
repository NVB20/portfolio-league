// The full table (LD-03, LD-07): a header, the loaded rows and a footer with "טען עוד 20", in one card.
// The window width picks the columns (tableColumns): phones show place, player and score with return and drawdown
// on a second line; tablets add return, drawdown and the change; wide screens add the two ranks and the daily bars.
// Rows are a plain .map, not a FlatList: a vertical list inside the page's ScrollView warns and gains nothing at
// 20 to 60 rows. Your row is tinted, outlined and marked "אתה" (LD-04); it reports where it is, for "לשורה שלי".

import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { LeaderboardRow, LeaderboardView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import {
  count, dailyBars, dayIndex, pct, PAGE_SIZE, points, rankDelta, rankText, rowLabel, shownRange, tableColumns,
  type Column, type TableLayout,
} from '../../leaderboard/board';
import type { MoreState } from '../../leaderboard/useLeaderboard';
import { Button } from '../dashboard/Button';
import { Chip } from '../dashboard/Chip';
import { Empty } from '../dashboard/Card';
import { ltr, useLayout } from '../dashboard/layout';
import { OffsetProvider, useMeasure } from '../dashboard/motion';
import { Avatar } from './Avatar';

type Props = {
  board: LeaderboardView;
  loading: boolean;              // a reload or a view switch is on its way: the rows dim until it lands
  more: MoreState;
  onMore: () => void;
  onMeAt: (y: number) => void;   // your row's top inside the scroll
};

export function LeaderboardTable({ board, loading, more, onMore, onMeAt }: Props) {
  const { colors } = useTheme();
  const { width } = useLayout();
  const layout = tableColumns(width);
  const card = useMeasure();
  const list = useMeasure(card.abs);
  const today = board.week ? dayIndex(board.week) : -1;
  const range = shownRange(board.rows);

  return (
    <View onLayout={card.onLayout} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {board.rows.length === 0 ? (
        <View style={styles.empty}>
          <Empty>{board.week ? 'אין שורות להצגה בטבלה הזו.' : 'הטבלה תתמלא אחרי שהציונים יחושבו.'}</Empty>
        </View>
      ) : (
        <>
          <HeaderRow layout={layout} />
          <View onLayout={list.onLayout} style={loading && styles.dim}>
            <OffsetProvider value={list.abs}>
              {board.rows.map((r) => (
                <Row key={r.rank} row={r} layout={layout} today={today} onMeAt={r.isMe ? onMeAt : undefined} />
              ))}
            </OffsetProvider>
          </View>
          <View style={[styles.foot, { paddingHorizontal: layout.padX }]}>
            {range ? (
              <View style={styles.footText}>
                <Text style={[styles.footLabel, { color: colors.faint }]}>מציג</Text>
                <Text style={[styles.footLabel, styles.num, { color: colors.faint }]}>{range}</Text>
                <Text style={[styles.footLabel, { color: colors.faint }]}>מתוך</Text>
                <Text style={[styles.footLabel, styles.num, { color: colors.faint }]}>{count(board.players)}</Text>
              </View>
            ) : null}
            {board.hasMore ? (
              <View style={styles.more}>
                {more === 'failed' ? <Text style={[styles.footLabel, { color: colors.neg }]}>לא נטען. נסו שוב.</Text> : null}
                <Button
                  small
                  label={more === 'loading' ? 'טוען…' : `טען עוד ${PAGE_SIZE} ↓`}
                  onPress={onMore}
                  disabled={more === 'loading' || loading}
                  hint="מוסיף את המקומות הבאים לטבלה"
                />
              </View>
            ) : null}
          </View>
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
            {c.key === 'score' ? `${c.label} ↓` : c.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Row({ row, layout, today, onMeAt }: { row: LeaderboardRow; layout: TableLayout; today: number; onMeAt?: (y: number) => void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const box = useMeasure();
  useEffect(() => {
    if (onMeAt && box.measured) onMeAt(box.abs);
  }, [onMeAt, box.abs, box.measured]);

  return (
    <View
      accessible
      accessibilityLabel={rowLabel(row)}
      onLayout={onMeAt ? box.onLayout : undefined}
      onPointerEnter={Platform.OS === 'web' ? () => setHovered(true) : undefined}
      onPointerLeave={Platform.OS === 'web' ? () => setHovered(false) : undefined}
      style={[
        styles.row,
        styles.body,
        rowPadding(layout),
        { borderBottomColor: colors.line },
        hovered && { backgroundColor: colors.surface2 },
        // borderBottomColor too: the longhand above would beat borderColor and leave the outline open at the bottom.
        row.isMe && { backgroundColor: colors.accentTint, borderColor: colors.accent, borderBottomColor: colors.accent },
      ]}
    >
      {layout.columns.map((c) => (
        <View key={c.key} style={cellBox(c)}>
          <Cell column={c} row={row} subLine={layout.subLine} today={today} />
        </View>
      ))}
    </View>
  );
}

function Cell({ column, row, subLine, today }: { column: Column; row: LeaderboardRow; subLine: boolean; today: number }) {
  const { colors } = useTheme();
  switch (column.key) {
    case 'rank': {
      const top = row.rank <= 3;
      const bg = top ? colors.accent : row.isMe ? colors.fg : colors.surface2;
      const fg = top ? colors.accentInk : row.isMe ? colors.page : colors.muted;
      return (
        <View style={[styles.rankCircle, { backgroundColor: bg }]}>
          <Text style={[styles.rankText, { color: fg }]}>{row.rank}</Text>
        </View>
      );
    }
    case 'player':
      return (
        <View style={styles.player}>
          <Avatar name={row.name} avatar={row.avatar} isMe={row.isMe} />
          <View style={styles.who}>
            <Text style={[styles.name, { color: colors.fg }]} numberOfLines={1}>
              {row.name}
            </Text>
            {subLine ? (
              // Each figure is its own text run, so a signed percent never flips inside the Hebrew words.
              <View style={styles.subLine}>
                <Text style={[styles.sub, { color: colors.faint }]}>תשואה</Text>
                <Text style={[styles.sub, styles.num, { color: row.returnPct < 0 ? colors.neg : colors.faint }]}>{pct(row.returnPct)}</Text>
                <Text style={[styles.sub, { color: colors.faint }]}>· ירידה</Text>
                <Text style={[styles.sub, styles.num, { color: colors.faint }]}>{pct(-row.maxDrawdownPct, 1)}</Text>
              </View>
            ) : null}
          </View>
          {row.isMe ? <Chip>אתה</Chip> : null}
        </View>
      );
    case 'score':
      return (
        <View>
          <Text style={[styles.score, styles.num, { color: colors.fg }]}>{points(row.score)}</Text>
          <View style={[styles.track, ltr, { backgroundColor: colors.line2 }]}>
            <View style={[styles.trackFill, { width: `${Math.min(100, Math.max(0, row.score))}%`, backgroundColor: colors.accent }]} />
          </View>
        </View>
      );
    case 'return':
      return (
        <View style={styles.start}>
          <Chip variant={row.returnPct > 0 ? 'up' : row.returnPct < 0 ? 'down' : 'ghost'}>{pct(row.returnPct)}</Chip>
        </View>
      );
    case 'drawdown':
      return <Text style={[styles.cellText, styles.num, { color: colors.muted }]}>{pct(-row.maxDrawdownPct, 1)}</Text>;
    case 'returnRank':
      return <Text style={[styles.cellText, styles.num, { color: colors.muted }]}>{rankText(row.returnRank)}</Text>;
    case 'stabilityRank':
      return <Text style={[styles.cellText, styles.num, { color: colors.muted }]}>{rankText(row.stabilityRank)}</Text>;
    case 'change': {
      const d = rankDelta(row.rankChange);
      const color = d.tone === 'up' ? colors.accent : d.tone === 'down' ? colors.neg : colors.faint;
      return <Text style={[styles.cellText, styles.num, styles.delta, { color }]}>{d.text}</Text>;
    }
    case 'days':
      return (
        <View style={[styles.bars, ltr]}>
          {dailyBars(row.days, today).map((b, i) => (
            <View key={i} style={styles.barSlot}>
              {b.height === null ? null : (
                <View style={[styles.bar, { height: `${b.height}%`, backgroundColor: b.today ? colors.accent : colors.line2 }]} />
              )}
            </View>
          ))}
        </View>
      );
  }
}

const rowPadding = (l: TableLayout) => ({ paddingHorizontal: l.padX, paddingVertical: l.padY, gap: l.gap });
// The name takes what the fixed columns leave; minWidth 0 lets it shrink and truncate instead of pushing the row.
const cellBox = (c: Column) => (c.width === null ? styles.flexCell : { width: c.width });

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 22, overflow: 'hidden' },
  empty: { padding: 20 },
  dim: { opacity: 0.55 },
  // Every row has a 1px border all round (transparent but the bottom line), so the outlined "you" row is exactly
  // as tall and wide as the others.
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  body: { minHeight: 60 },
  headText: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.2 },
  flexCell: { flex: 1, minWidth: 0 },
  num: { fontVariant: ['tabular-nums'] },
  rankCircle: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontSize: 12.5, fontWeight: '600' },
  player: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  who: { flexShrink: 1, minWidth: 0 },
  // alignSelf 'flex-start' on the name and the number cells: on the web every Text gets dir="auto", so a Latin name
  // or a number alone is laid out left to right and would sit on the LEFT of its cell, under a right-aligned Hebrew
  // header. Sized to its content, the Text sits at the row's start (the right) instead. Not dir="rtl", which would
  // move a number's + / − sign to the wrong side.
  name: { fontSize: 13.5, fontWeight: '600', alignSelf: 'flex-start' },
  subLine: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, marginTop: 2 },
  sub: { fontSize: 11.5 },
  score: { fontSize: 15, fontWeight: '600', alignSelf: 'flex-start' },
  track: { height: 3, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 2 },
  start: { alignItems: 'flex-start' },
  cellText: { fontSize: 13.5, alignSelf: 'flex-start' },
  delta: { fontWeight: '600' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 22 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { minHeight: 2, borderRadius: 2 },
  foot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 14 },
  footText: { flexDirection: 'row', gap: 4 },
  footLabel: { fontSize: 12.5 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
