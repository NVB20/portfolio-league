// Another player's round avatar on the board: the first letter of their name on one of five muted fills (LD-06,
// LD-08). Your own initial sits on the accent. Decorative: the name next to it is what a screen reader reads.

import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../useTheme';
import { fixed } from '../../theme';
import { avatarSlot, initial } from '../../leaderboard/board';

export function Avatar({ name, avatar, isMe, size = 34 }: { name: string; avatar: number; isMe: boolean; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: isMe ? colors.accent : fixed.avatarFills[avatarSlot(avatar)] },
      ]}
    >
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.38), color: isMe ? colors.accentInk : fixed.avatarInk }]}>{initial(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  letter: { fontWeight: '600' },
});
