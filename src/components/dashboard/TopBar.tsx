// The floating top bar: logo, page tabs, the world clock, and the avatar that opens the user menu (DD-09, DD-12).
// On the admin page (side="admin") a "ניהול" badge replaces the tabs and a button leads back to the player side.
// It lies OVER the scrolling page (absolute), so the cards slide underneath it like in the mock-up.
// Web: see-through page color + blur, no border. Phones: solid page color (no blur on native).
// "סקירה" (/dashboard) and "מסחר" (/trade) exist; the other tabs are shown disabled until their screens are built.

import { useState } from 'react';
import { Animated, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ClockView } from '../../../api/src/contract';
import { useTheme } from '../../useTheme';
import { dayLabel } from '../../dashboard/format';
import { MAX_WIDTH, useLayout } from './layout';
import { useLoop } from './motion';
import { UserMenu } from './UserMenu';
import { Button } from './Button';

export type Page = 'dashboard' | 'trade';
const TABS: { label: string; page: Page | null }[] = [
  { label: 'סקירה', page: 'dashboard' },
  { label: 'מסחר', page: 'trade' },
  { label: 'פקודות', page: null },
  { label: 'טבלה', page: null },
  { label: 'היסטוריה', page: null },
];
export const BAR_HEIGHT = 68;
const LOGO_HEIGHT = 40;
const LOGO_RATIO = 577 / 624;   // assets/logo.png

// side 'admin': the admin page. A "ניהול" badge replaces the player tabs, and a button leads back.
export type Side = 'player' | 'admin';

type Props = { clock: ClockView | null; name: string; rankLine: string | null; active?: Page; side?: Side };

export function TopBar({ clock, name, rankLine, active = 'dashboard', side = 'player' }: Props) {
  const { colors } = useTheme();
  const { isPhone } = useLayout();
  const [menuOpen, setMenuOpen] = useState(false);
  const taseOpen = clock?.markets.tase.isOpen ?? false;
  const blink = useLoop(2000);   // the live dot pulses while the market is open

  return (
    <View style={[styles.bar, Platform.OS === 'web' ? [{ backgroundColor: colors.barBackground }, blur] : { backgroundColor: colors.page }]}>
      <View style={styles.inner}>
        <Image source={require('../../../assets/logo.png')} style={styles.logo} accessibilityLabel="ליגת תיקים" />

        {/* The rounded pill IS the scroll area, so on a narrow screen the tabs scroll inside its rounded edge. */}
        <View style={styles.tabsSlot}>
        {side === 'admin' ? (
          <View style={[styles.badge, { backgroundColor: colors.accentTint }]}>
            <Text style={[styles.badgeText, { color: colors.accent }]}>ניהול</Text>
          </View>
        ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabsPill, { backgroundColor: colors.surface, borderColor: colors.line }]}
          contentContainerStyle={styles.tabsContent}
        >
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map(({ label, page }) => {
              const on = page === active;
              const built = page !== null;
              return (
                <Pressable
                  key={label}
                  disabled={!built}
                  onPress={built && !on ? () => router.navigate(`/${page}`) : undefined}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on, disabled: !built }}
                  style={[styles.tab, on && { backgroundColor: colors.accent }]}
                >
                  <Text style={[styles.tabText, { color: on ? colors.accentInk : colors.muted }, on && { fontWeight: '600' }, !built && { opacity: 0.6 }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
        )}
        </View>

        {clock && !isPhone ? (
          <View style={[styles.clock, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <Animated.View
              style={[
                styles.dot,
                { backgroundColor: taseOpen ? colors.accent : colors.faint },
                taseOpen && { opacity: blink.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }) },
              ]}
            />
            <Text style={[styles.clockText, { color: colors.fg }]}>{`${dayLabel(clock.weekday)} · ${clock.time}`}</Text>
            <Text style={[styles.clockText, { color: colors.muted }]}>{taseOpen ? '· תל אביב פתוח' : '· תל אביב סגור'}</Text>
          </View>
        ) : null}

        {/* Phones: the way back is in the avatar menu instead, to keep the bar from overflowing. */}
        {side === 'admin' && !isPhone ? (
          <Button label="חזרה לצד השחקן" small onPress={() => router.navigate('/dashboard')} />
        ) : null}

        <Pressable
          onPress={() => setMenuOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="תפריט המשתמש"
          accessibilityState={{ expanded: menuOpen }}
          style={styles.user}
        >
          <View style={[styles.avatar, { backgroundColor: colors.avatarA, borderColor: colors.line2 }]}>
            <Ionicons name="person" size={20} color={colors.avatarFg} />
            <View style={[styles.online, { backgroundColor: colors.accent, borderColor: colors.page }]} />
          </View>
          {!isPhone ? (
            <View>
              <Text style={[styles.name, { color: colors.fg }]} numberOfLines={1}>{name}</Text>
              {rankLine ? <Text style={[styles.rank, { color: colors.faint }]}>{rankLine}</Text> : null}
            </View>
          ) : null}
        </Pressable>
      </View>

      <UserMenu open={menuOpen} onClose={() => setMenuOpen(false)} name={name} rankLine={rankLine} top={BAR_HEIGHT} side={side} />
    </View>
  );
}

// CSS backdrop-filter (frosted glass). Inline and cast: React Native's style types don't include it.
const blur = { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' } as unknown as object;

const styles = StyleSheet.create({
  bar: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9 },
  inner: { flexDirection: 'row', alignItems: 'center', gap: 14, height: BAR_HEIGHT, paddingHorizontal: 16, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  logo: { height: LOGO_HEIGHT, width: LOGO_HEIGHT * LOGO_RATIO },
  tabsSlot: { flex: 1, minWidth: 0, alignItems: 'center' },
  tabsPill: { flexGrow: 0, maxWidth: '100%', borderRadius: 999, borderWidth: 1 },
  tabsContent: { padding: 4 },
  tabs: { flexDirection: 'row', gap: 4 },
  tab: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 999 },
  tabText: { fontSize: 13.5, fontWeight: '500' },
  badge: { borderRadius: 999, paddingVertical: 7, paddingHorizontal: 16 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  clock: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  clockText: { fontSize: 13 },
  user: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  online: { position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  name: { fontSize: 13, fontWeight: '600', maxWidth: 120 },
  rank: { fontSize: 11 },
});
