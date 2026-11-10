// The rejection toast (D-023): the orders the runner refused since the player last looked, all on one card
// that floats under the top bar, newest first, each with what it was, why, and when. It stays until closed.
// Only once it has fully appeared, in a tab the player is looking at, does it report those ids as seen (D-031), so it
// never marks one the player didn't see.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { HoldingView, RejectionView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { rejectionsHeading, type RejectionNotice } from '../../dashboard/rejections';
import { useRejectionToasts } from '../../dashboard/useRejectionToasts';
import { MAX_WIDTH } from './layout';
import { useReduce } from './motion';
import { BAR_HEIGHT } from './TopBar';

const TOAST_WIDTH = 400;

export function RejectionToasts({ rejections, holdings }: { rejections: RejectionView[]; holdings: HoldingView[] }) {
  const { notices, markShown, close } = useRejectionToasts(rejections, holdings);
  if (notices.length === 0) return null;
  return (
    // box-none: taps outside the card reach the page underneath.
    <View style={styles.layer} pointerEvents="box-none">
      <View style={styles.column} pointerEvents="box-none">
        <Toast notices={notices} onShown={markShown} onClose={close} />
      </View>
    </View>
  );
}

function Toast({ notices, onShown, onClose }: { notices: RejectionNotice[]; onShown: (ids: string[]) => void; onClose: () => void }) {
  const { colors } = useTheme();
  const reduce = useReduce();
  const show = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const [entered, setEntered] = useState(reduce);
  const visible = usePageVisible();

  // Slides down and fades in. "On screen" = the animation finished and the page is visible: under reduce motion
  // there is no animation to wait for, so the visibility check is what keeps a hidden tab from marking them.
  useEffect(() => {
    if (reduce) {
      show.setValue(1);
      setEntered(true);
      return;
    }
    const a = Animated.timing(show, { toValue: 1, duration: 320, easing: Easing.bezier(0.2, 0.7, 0.2, 1), useNativeDriver: false });
    a.start(({ finished }) => finished && setEntered(true));
    return () => a.stop();
  }, [show, reduce]);

  // After the render that put these notices on screen. New ones from a later load are reported the same way.
  const ids = notices.map((n) => n.id).join(',');
  useEffect(() => {
    if (entered && visible && ids) onShown(ids.split(','));
  }, [entered, visible, ids, onShown]);

  return (
    <Animated.View
      accessibilityRole="alert"
      style={[
        styles.toast,
        { backgroundColor: colors.surface, borderColor: colors.line2 },
        { opacity: show, transform: [{ translateY: show.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }] },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: colors.neg }]} />
        <View style={styles.headText}>
          <Text style={[styles.heading, { color: colors.fg }]}>{rejectionsHeading(notices.length)}</Text>
          <Text style={[styles.sub, { color: colors.faint }]}>הכסף או היחידות שנשמרו חזרו לתיק.</Text>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="סגור"
          hitSlop={8}
          style={({ pressed }) => [styles.close, { backgroundColor: colors.surface2, borderColor: colors.line2 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={[styles.closeText, { color: colors.muted }]}>✕</Text>
        </Pressable>
      </View>

      {notices.map((n) => (
        <View key={n.id} style={[styles.item, { borderTopColor: colors.line }]} accessible accessibilityLabel={`${n.title}. ${n.reason}. ${n.when}`}>
          <View style={styles.itemHead}>
            <Text style={[styles.title, { color: colors.fg }]}>{n.title}</Text>
            <Text style={[styles.when, { color: colors.faint }]}>{n.when}</Text>
          </View>
          <Text style={[styles.reason, { color: colors.muted }]}>{n.reason}</Text>
        </View>
      ))}
    </Animated.View>
  );
}

// Web: false while the tab is hidden (opened in the background, or switched away). Native: always true, since the
// toast only renders while the app is in front.
function usePageVisible(): boolean {
  const web = Platform.OS === 'web' && typeof document !== 'undefined';
  const [visible, setVisible] = useState(() => !web || document.visibilityState !== 'hidden');
  useEffect(() => {
    if (!web) return;
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [web]);
  return visible;
}

const styles = StyleSheet.create({
  // Under the floating top bar, in the page's content column, starting on the right like the page.
  layer: { position: 'absolute', top: BAR_HEIGHT + 8, left: 0, right: 0, zIndex: 8 },
  column: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 16, alignItems: 'flex-start' },
  toast: {
    width: '100%',
    maxWidth: TOAST_WIDTH,
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  headText: { flex: 1 },
  heading: { fontSize: 14.5, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  close: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 12 },
  item: { borderTopWidth: 1, paddingVertical: 9, gap: 2 },
  itemHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  when: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  reason: { fontSize: 12.5, lineHeight: 18 },
});
