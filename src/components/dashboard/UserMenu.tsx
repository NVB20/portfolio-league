// The avatar menu (DD-12): name and rank, the dark/light switch (D-007), the switch between the player and
// admin sides (for a player who isn't an admin yet, behind the demo password, D-043), "how to play" (and "how to
// manage" on the admin side), and log out.
// A Modal on every platform: it closes on a tap outside and on Escape/back (onRequestClose).

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { signOut } from 'firebase/auth';
import { auth } from '../../firebase';
import { ApiError } from '../../api';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../useTheme';
import { Theme } from '../../types/user';
import { ltr, rtl } from './layout';
import { useReduce } from './motion';
import type { Side } from './TopBar';

// The demo's admin password (D-043). Printed on purpose: a reviewer must reach the admin side without SQL.
// The API checks it (POST /me/admin) and adds the role; this copy is only the hint on the screen.
const ADMIN_PASSWORD_HINT = 'הזינו את הסיסמה: 123456';

type Props = { open: boolean; onClose: () => void; name: string; rankLine: string | null; top: number; side?: Side };

export function UserMenu({ open, onClose, name, rankLine, top, side = 'player' }: Props) {
  const { colors, theme, setTheme } = useTheme();
  const isAdmin = useAuth().roles.includes('admin');
  const reduce = useReduce();
  // A player's way to the admin side (D-043): the menu item turns into the password field, in place.
  const [askPassword, setAskPassword] = useState(false);
  // Every way out of the menu folds the field back, so the menu opens plain next time.
  const close = () => {
    setAskPassword(false);
    onClose();
  };
  // Armed while the password is being checked. The new role reaches `roles` on a later render than the API's
  // answer, so the move waits for that render, when the admin route's guard in _layout.tsx already lets them in
  // (sooner, it would send them back to /dashboard).
  const goAdmin = useRef(false);
  useEffect(() => {
    if (!goAdmin.current || !isAdmin) return;
    goAdmin.current = false;
    onClose();
    router.navigate('/admin-dashboard');
  }, [isAdmin, onClose]);
  // Pops in over 0.18s with a slight overshoot (DD-06).
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!open) return pop.setValue(0);
    if (reduce) return pop.setValue(1);
    Animated.timing(pop, { toValue: 1, duration: 180, easing: Easing.bezier(0.2, 0.9, 0.3, 1.2), useNativeDriver: false }).start();
  }, [open, reduce, pop]);

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={close}>
      <Pressable style={[styles.backdrop, rtl]} onPress={close} accessibilityLabel="סגירת התפריט">
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

          {/* Admins switch sides. A player gets the same item, which asks for the demo password first (D-043).
              Showing the item grants nothing: the route guard and the API still check the role. */}
          {side === 'admin' ? (
            <MenuItem
              icon="person-outline"
              label="מעבר לצד השחקן"
              onPress={() => {
                close();
                router.navigate('/dashboard');
              }}
            />
          ) : isAdmin ? (
            <MenuItem
              icon="shield-checkmark-outline"
              label="מעבר לצד הניהול"
              onPress={() => {
                close();
                router.navigate('/admin-dashboard');
              }}
            />
          ) : askPassword ? (
            <AdminPassword arm={(on) => (goAdmin.current = on)} onCancel={() => setAskPassword(false)} />
          ) : (
            <MenuItem icon="lock-closed-outline" label="מעבר לצד הניהול" onPress={() => setAskPassword(true)} />
          )}
          {/* On the admin side, "how to manage" reopens the admin walkthrough. */}
          {side === 'admin' ? (
            <MenuItem
              icon="school-outline"
              label="איך מנהלים"
              onPress={() => {
                close();
                router.navigate('/admin-onboarding');
              }}
            />
          ) : null}
          {/* The rules page (/how-to-play): every rule on one scroll. Its first section reopens the player walkthrough. */}
          <MenuItem
            icon="help-circle-outline"
            label="איך משחקים"
            onPress={() => {
              close();
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

// The password step (D-043). `arm(true)` before sending: once the role arrives, the menu's effect above navigates;
// until then the button keeps saying "בודק…". A wrong password disarms, shows under the field and changes nothing.
function AdminPassword({ arm, onCancel }: { arm: (on: boolean) => void; onCancel: () => void }) {
  const { colors } = useTheme();
  const { becomeAdmin } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = password !== '' && !busy;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    arm(true);
    try {
      await becomeAdmin(password);
    } catch (e) {
      arm(false);
      setError(e instanceof ApiError && e.status === 403 ? 'הסיסמה שגויה' : 'לא הצלחנו לבדוק את הסיסמה. נסו שוב.');
      setBusy(false);
    }
  };

  return (
    <View style={[styles.pwBox, { backgroundColor: colors.surface2, borderColor: colors.line }]}>
      <Text style={[styles.pwTitle, { color: colors.fg }]}>מעבר לצד הניהול</Text>
      <Text style={[styles.pwHint, { color: colors.muted }]}>{ADMIN_PASSWORD_HINT}</Text>
      <TextInput
        value={password}
        onChangeText={(t) => {
          setPassword(t);
          setError(null);
        }}
        onSubmitEditing={submit}
        editable={!busy}
        autoFocus
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={32}
        autoComplete="off"
        accessibilityLabel="סיסמת ניהול"
        style={[
          styles.pwInput,
          ltr,
          { color: colors.fg, backgroundColor: colors.surface, borderColor: error ? colors.neg : colors.line2 },
          webNoOutline,
        ]}
      />
      {error ? (
        <Text accessibilityRole="alert" style={[styles.pwError, { color: colors.neg }]}>
          {error}
        </Text>
      ) : null}
      <View style={styles.pwRow}>
        <Pressable
          onPress={submit}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend }}
          style={({ pressed }) => [
            styles.pwButton,
            { backgroundColor: colors.accent, borderColor: colors.accent },
            (!canSend || pressed) && { opacity: canSend ? 0.85 : 0.45 },
          ]}
        >
          <Text style={[styles.pwButtonText, { color: colors.accentInk }]}>{busy ? 'בודק…' : 'כניסה'}</Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [styles.pwButton, { borderColor: colors.line2 }, (busy || pressed) && { opacity: busy ? 0.45 : 0.85 }]}
        >
          <Text style={[styles.pwButtonText, { color: colors.fg }]}>ביטול</Text>
        </Pressable>
      </View>
    </View>
  );
}

const webNoOutline = { outlineStyle: 'none' } as unknown as object;

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
  pwBox: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 6, marginVertical: 2 },
  pwTitle: { fontSize: 13.5, fontWeight: '600' },
  pwHint: { fontSize: 12.5 },
  pwInput: { borderWidth: 1, borderRadius: 10, fontSize: 15, fontVariant: ['tabular-nums'], paddingVertical: 7, paddingHorizontal: 10 },
  pwError: { fontSize: 12, fontWeight: '600' },
  pwRow: { flexDirection: 'row', gap: 8 },
  pwButton: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 7, alignItems: 'center' },
  pwButtonText: { fontSize: 12.5, fontWeight: '600' },
});
