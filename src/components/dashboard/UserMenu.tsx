// The avatar menu (DD-12): name and rank, the dark/light switch (D-007), the switch between the player and
// admin sides (admins only), "how to play", and log out.
// A Modal on every platform: it closes on a tap outside and on Escape/back (onRequestClose).

import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { signOut } from 'firebase/auth';
import { auth } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../useTheme';
import { Theme } from '../../types/user';
import { rtl } from './layout';
import { useReduce } from './motion';
import type { Side } from './TopBar';

type Props = { open: boolean; onClose: () => void; name: string; rankLine: string | null; top: number; side?: Side };

export function UserMenu({ open, onClose, name, rankLine, top, side = 'player' }: Props) {
  const { colors, theme, setTheme } = useTheme();
  const isAdmin = useAuth().roles.includes('admin');
  const reduce = useReduce();
  // Pops in over 0.18s with a slight overshoot (DD-06).
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!open) return pop.setValue(0);
    if (reduce) return pop.setValue(1);
    Animated.timing(pop, { toValue: 1, duration: 180, easing: Easing.bezier(0.2, 0.9, 0.3, 1.2), useNativeDriver: false }).start();
  }, [open, reduce, pop]);

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, rtl]} onPress={onClose} accessibilityLabel="סגירת התפריט">
        {/* Inner Pressable swallows taps so tapping inside the menu doesn't close it. */}
        <Animated.View
          style={[
            styles.menu,
            { top, backgroundColor: colors.surface, borderColor: colors.line2 },
            { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] },
          ]}
        >
        <Pressable onPress={() => {}} accessibilityRole="menu" style={styles.menuInner}>
          <View style={[styles.header, { borderBottomColor: colors.line }]}>
            <Text style={[styles.name, { color: colors.fg }]}>{name}</Text>
            {rankLine ? <Text style={[styles.rank, { color: colors.faint }]}>{rankLine}</Text> : null}
          </View>

          <View style={styles.themeRow}>
            <Text style={[styles.label, { color: colors.faint }]}>ערכת נושא</Text>
            {/* Two options, not one toggle: a toggle's label leaves you guessing whether it's the state or the action. */}
            <View style={[styles.seg, { backgroundColor: colors.surface2, borderColor: colors.line }]} accessibilityRole="radiogroup">
              <ThemeOption value="light" label="בהיר" icon="sunny-outline" current={theme} onPick={setTheme} />
              <ThemeOption value="dark" label="כהה" icon="moon-outline" current={theme} onPick={setTheme} />
            </View>
          </View>

          {/* Admins only. This only hides the button; the route guard and the API still check the role. */}
          {side === 'admin' ? (
            <MenuItem
              icon="person-outline"
              label="מעבר לצד השחקן"
              onPress={() => {
                onClose();
                router.navigate('/dashboard');
              }}
            />
          ) : isAdmin ? (
            <MenuItem
              icon="shield-checkmark-outline"
              label="מעבר לצד הניהול"
              onPress={() => {
                onClose();
                router.navigate('/admin-dashboard');
              }}
            />
          ) : null}
          {/* The rules page (/how-to-play): every rule on one scroll. */}
          <MenuItem
            icon="help-circle-outline"
            label="איך משחקים"
            onPress={() => {
              onClose();
              router.navigate('/how-to-play');
            }}
          />
          <View style={[styles.hr, { backgroundColor: colors.line }]} />
          <MenuItem icon="log-out-outline" label="התנתקות" danger onPress={() => signOut(auth)} />
        </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function ThemeOption({ value, label, icon, current, onPick }: {
  value: Theme;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  current: Theme;
  onPick: (t: Theme) => void;
}) {
  const { colors } = useTheme();
  const on = value === current;
  return (
    <Pressable
      onPress={() => onPick(value)}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      style={[styles.segOption, on && { backgroundColor: colors.accent }]}
    >
      <Ionicons name={icon} size={14} color={on ? colors.accentInk : colors.muted} />
      <Text style={[styles.segText, { color: on ? colors.accentInk : colors.muted }, on && { fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

function MenuItem({ icon, label, onPress, danger = false, disabled = false }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const color = danger ? colors.neg : colors.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="menuitem"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.surface2 }, disabled && { opacity: 0.45 }]}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.itemText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The Modal renders outside the screen's tree, so the Hebrew direction is set again here.
  backdrop: { flex: 1 },
  // left: under the avatar, which sits at the left end of the Hebrew top bar.
  menu: { position: 'absolute', left: 16, width: 248, borderWidth: 1, borderRadius: 18, padding: 8, gap: 2,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  menuInner: { gap: 2 },
  header: { paddingTop: 8, paddingHorizontal: 10, paddingBottom: 10, borderBottomWidth: 1, marginBottom: 4 },
  name: { fontSize: 14, fontWeight: '600' },
  rank: { fontSize: 11.5 },
  themeRow: { gap: 6, paddingTop: 6, paddingHorizontal: 10, paddingBottom: 8 },
  label: { fontSize: 12 },
  seg: { flexDirection: 'row', gap: 3, padding: 3, borderRadius: 999, borderWidth: 1 },
  segOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 999, paddingVertical: 7 },
  segText: { fontSize: 12.5, fontWeight: '500' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12 },
  itemText: { fontSize: 13.5, fontWeight: '500' },
  hr: { height: 1, marginVertical: 4 },
});
