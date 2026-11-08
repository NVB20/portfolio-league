// The card frame every dashboard card uses: title + one-line description on the right, an optional
// chip/icon slot on the left (`end`), then the content (DD-05).
//
// `inverse` = the one card per section with the opposite polarity to the page (DD-04, DD-11).
// Everything inside reads its colors from usePalette(), so chips and text flip with the card by themselves.

import { createContext, ReactNode, useContext, useState } from 'react';
import { Platform, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../../useTheme';
import { fixed } from '../../theme';
import { useReduce } from './motion';

type Tone = 'base' | 'inverse';
const ToneContext = createContext<Tone>('base');

// The colors for content inside the current card, by role rather than by hex.
export function usePalette() {
  const { colors } = useTheme();
  const tone = useContext(ToneContext);
  if (tone === 'inverse') {
    return {
      tone,
      fg: colors.inverseInk,
      body: colors.inverseInk,
      sub: colors.inverseMuted,
      tile: colors.inverseTile,
      line: colors.inverseLine,
      accentFill: fixed.inverseAccent,
      accentFillInk: fixed.inverseAccentInk,
      up: colors.inverseInk,
      down: colors.neg,
      warn: colors.inverseWarn,
    };
  }
  return {
    tone,
    fg: colors.fg,
    body: colors.muted,
    sub: colors.faint,
    tile: colors.surface2,
    line: colors.line,
    accentFill: colors.accent,
    accentFillInk: colors.accentInk,
    up: colors.accent,
    down: colors.neg,
    warn: colors.warn,
  };
}

type Props = {
  title: string;
  sub?: string;
  head?: ReactNode;      // replaces the title + sub block (the holding cards show a ticker pill there)
  end?: ReactNode;
  inverse?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Card({ title, sub, head, end, inverse = false, children, style }: Props) {
  const { colors } = useTheme();
  const reduce = useReduce();
  const [hovered, setHovered] = useState(false);
  const look = inverse
    ? { backgroundColor: colors.inverse, borderColor: colors.inverseEdge }
    : { backgroundColor: colors.surface, borderColor: colors.line };

  const content = (
    <>
      <View style={styles.head}>
        {head ?? (
          <View style={styles.titles}>
            <Text style={[styles.title, { color: inverse ? colors.inverseInk : colors.fg }]}>{title}</Text>
            {sub ? <Text style={[styles.sub, { color: inverse ? colors.inverseMuted : colors.faint }]}>{sub}</Text> : null}
          </View>
        )}
        {end ? <View style={styles.end}>{end}</View> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </>
  );

  return (
    <ToneContext.Provider value={inverse ? 'inverse' : 'base'}>
      {/* Web: hover lifts the card 2px and brightens its border (DD-06: nothing else).
          A plain View with pointer events, not a Pressable: on the web a Pressable becomes a keyboard tab stop
          with a pointer cursor, which makes a card look clickable when only the buttons inside it are. */}
      <View
        accessibilityLabel={title}
        onPointerEnter={Platform.OS === 'web' ? () => setHovered(true) : undefined}
        onPointerLeave={Platform.OS === 'web' ? () => setHovered(false) : undefined}
        style={[
          styles.card,
          look,
          Platform.OS === 'web' && !reduce && hoverTransition,
          hovered && { transform: [{ translateY: -2 }], zIndex: 2 },
          hovered && !inverse && { borderColor: colors.line2 },
          hovered && hoverShadow,
          style,
        ]}
      >
        {content}
      </View>
    </ToneContext.Provider>
  );
}

// Web-only CSS, cast because React Native's style types don't include it. No transition under reduce motion.
const hoverTransition = {
  transitionProperty: 'transform, border-color, box-shadow',
  transitionDuration: '250ms',
  transitionTimingFunction: 'cubic-bezier(.2,.7,.2,1)',
} as unknown as ViewStyle;
const hoverShadow = { boxShadow: '0 18px 32px -26px rgba(0, 0, 0, 0.9)' } as unknown as ViewStyle;

// What a card shows when there's no data yet. Says what will fill it, never a fake number.
export function Empty({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.empty, { color: p.sub }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: { flexGrow: 1, borderWidth: 1, borderRadius: 22, padding: 20, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  titles: { flexShrink: 1 },
  title: { fontSize: 15, fontWeight: '500' },
  sub: { fontSize: 12.5, marginTop: 2 },
  end: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  body: { flexGrow: 1 },
  empty: { fontSize: 13.5, lineHeight: 20, marginTop: 14 },
});
