// A tile that explains itself: a tap opens a small bubble right beside it (the score and rank tiles: what the number
// is and how it is worked out). The copy comes from src/leaderboard/board.ts (rankTip, scoreTip).
//
// The bubble is a transparent Modal, like the avatar menu: it sits above every card on every platform, and a tap
// anywhere or Escape/back (onRequestClose) closes it. It is placed from the tile's position on the screen
// (measureInWindow): under the tile, or above it when the tile is low on the screen, with a caret pointing at it.

import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Easing, type HostInstance, Modal, Pressable, StyleProp, StyleSheet, Text, useWindowDimensions, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Tip } from '../../leaderboard/board';
import { useTheme } from '../../useTheme';
import { usePalette } from './Card';
import { ltr, rtl } from './layout';
import { useReduce } from './motion';

const WIDTH = 280;   // the bubble's width, narrower on a phone
const GUTTER = 16;   // the bubble keeps this far from the screen's edges
const GAP = 10;      // between the tile and the bubble
const CARET = 12;

type Rect = { x: number; y: number; width: number; height: number };

// `style` is the tile's own style: this Pressable IS the tile, so it keeps its place in the row.
// `markColor`: the corner mark's color on a filled tile (default: the card's quiet text color).
export function InfoTip({ tip, label, style, markColor, children }: {
  tip: Tip;
  label: string;
  style?: StyleProp<ViewStyle>;
  markColor?: string;
  children: ReactNode;
}) {
  const p = usePalette();
  const ref = useRef<HostInstance>(null);
  const [at, setAt] = useState<Rect | null>(null);
  return (
    <>
      <Pressable
        ref={ref}
        onPress={() => ref.current?.measureInWindow((x, y, width, height) => setAt({ x, y, width, height }))}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="פותח הסבר קצר"
        style={({ pressed }) => [style, pressed && { opacity: 0.8 }]}
      >
        {children}
        {/* The corner mark that says the tile opens an explanation. The tiles' top-left corner is empty in Hebrew. */}
        <Ionicons name="information-circle-outline" size={15} color={markColor ?? p.sub} style={styles.mark} />
      </Pressable>
      {at ? <Bubble tip={tip} at={at} onClose={() => setAt(null)} /> : null}
    </>
  );
}

function Bubble({ tip, at, onClose }: { tip: Tip; at: Rect; onClose: () => void }) {
  const { colors } = useTheme();
  const screen = useWindowDimensions();
  const reduce = useReduce();
  // Pops in over 0.16s, sliding 6px from the tile's side (DD-06). Nothing moves under reduce motion.
  const pop = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) return;
    Animated.timing(pop, { toValue: 1, duration: 160, easing: Easing.bezier(0.2, 0.9, 0.3, 1.2), useNativeDriver: false }).start();
  }, [reduce, pop]);

  const width = Math.min(WIDTH, screen.width - 2 * GUTTER);
  const center = at.x + at.width / 2;
  // Centered on the tile, but never past the screen's edges. Physical left: see layout.ts.
  const left = Math.min(Math.max(center - width / 2, GUTTER), screen.width - GUTTER - width);
  const caretLeft = Math.min(Math.max(center - left - CARET / 2, 16), width - 16 - CARET);
  const above = at.y + at.height / 2 > screen.height * 0.55;
  const box = { backgroundColor: colors.surface, borderColor: colors.line2 };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* The Modal renders outside the screen's tree, so the Hebrew direction is set again here. */}
      <Pressable style={[styles.backdrop, rtl]} onPress={onClose} accessibilityLabel="סגירת ההסבר">
        <Animated.View
          style={[
            styles.bubble,
            box,
            { width, left },
            above ? { bottom: screen.height - at.y + GAP } : { top: at.y + at.height + GAP },
            { opacity: pop, transform: [{ translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [above ? 6 : -6, 0] }) }] },
          ]}
        >
          <View style={[styles.caret, box, { left: caretLeft }, above ? styles.caretDown : styles.caretUp]} />
          <Text style={[styles.title, { color: colors.fg }]}>{tip.title}</Text>
          {tip.lines.map((line) => (
            <Text key={line} style={[styles.line, { color: colors.muted }]}>{line}</Text>
          ))}
          {tip.sum ? <Text style={[styles.sum, ltr, { color: colors.fg, backgroundColor: colors.surface2 }]}>{tip.sum}</Text> : null}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mark: { position: 'absolute', top: 8, left: 8 },
  backdrop: { flex: 1 },
  bubble: { position: 'absolute', borderWidth: 1, borderRadius: 16, padding: 14, gap: 6,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  // A square turned 45°, two of its borders drawn: they make the point. It covers the bubble's border where they meet.
  caret: { position: 'absolute', width: CARET, height: CARET },
  caretUp: { top: -CARET / 2 - 1, borderTopWidth: 1, borderLeftWidth: 1, transform: [{ rotate: '45deg' }] },
  caretDown: { bottom: -CARET / 2 - 1, borderBottomWidth: 1, borderRightWidth: 1, transform: [{ rotate: '45deg' }] },
  title: { fontSize: 13.5, fontWeight: '600' },
  line: { fontSize: 12.5, lineHeight: 18 },
  sum: { fontSize: 13, fontWeight: '600', textAlign: 'center', borderRadius: 10, paddingVertical: 7, paddingHorizontal: 10, marginTop: 4,
    fontVariant: ['tabular-nums'] },
});
