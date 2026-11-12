// The wrapper around EVERY screen in src/app, and the place where we block
// logged-out users. Because it wraps everything, nothing gets past it.

import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { usePresence } from '../auth/usePresence';
import { onboardingDue } from '../onboarding/due';
import { useUsageTracking } from '../usage/useUsageTracking';
import { light } from '../theme';
import { useTheme } from '../useTheme';
import { useWebTheme } from '../useWebTheme';

export default function RootLayout() {
  // AuthProvider must be OUTSIDE the guard, so the guard can call useAuth().
  return (
    <AuthProvider>
      <GuardedStack />
    </AuthProvider>
  );
}

function GuardedStack() {
  const { user, me, roles, isLoading } = useAuth();
  // First visit: the player's walkthrough, and the admin's on the admin side. Never when `me` is missing (onboardingDue).
  const playerOnboardingDue = onboardingDue(me, 'player');
  // Only for admins: a non-admin is always "due" on the server's side (it never sets their admin field), and must
  // reach /dashboard through the outer guard below, not wait on a walkthrough they can't open.
  const adminOnboardingDue = roles.includes('admin') && onboardingDue(me, 'admin');
  const { theme } = useTheme();
  // Logged in: the user's theme. Logged out: the login page looks the same for everyone (light form side).
  useWebTheme(user ? theme : 'light');
  // Logged in with a row in our API: check in now and once a minute, for "online now" on the admin page.
  usePresence(user !== null && me !== null);
  // The same players: which page they use and for how long, sent with those check-ins (D-036).
  useUsageTracking(user !== null && me !== null);

  // Firebase hasn't answered yet: show a spinner and NO screen at all.
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: light.background }}>
        <ActivityIndicator size="large" color={light.primary} />
      </View>
    );
  }

  // Stack.Protected: a screen can only be opened while its `guard` is true.
  // Otherwise the router sends the user away (redirectTo).
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Logged OUT only: the login page. A user who is logged in is sent to "/" explicitly. Without redirectTo
          expo-router picks the first unguarded route, which is the generated _sitemap (404) whenever the index is
          guarded because the player's walkthrough is due. "/" goes on to /onboarding when due, else /dashboard. */}
      <Stack.Protected guard={user === null} redirectTo="/">
        <Stack.Screen name="login" />
      </Stack.Protected>

      {/* Logged IN only: everything else. Logged-out visitors go to /login. */}
      <Stack.Protected guard={user !== null} redirectTo="/login">
        {/* The player walkthrough: always open to a logged-in user, also after it was seen (the rules page reopens it). */}
        <Stack.Screen name="onboarding" />

        {/* The rules page, from "איך משחקים" in the avatar menu. Open to anyone logged in, like the walkthrough. */}
        <Stack.Screen name="how-to-play" />

        {/* The player pages. Until the player has seen the walkthrough they are sent to it. markOnboardingSeen
            updates `me` at once, so this guard passes the moment they finish: no loop. */}
        <Stack.Protected guard={!playerOnboardingDue} redirectTo="/onboarding">
          <Stack.Screen name="index" />
          <Stack.Screen name="dashboard" />
          <Stack.Screen name="trade" />
          <Stack.Screen name="journal" />
          <Stack.Screen name="leaderboard" />
        </Stack.Protected>

        {/* Admins only. Everyone else goes back to their dashboard.
            This is a convenience: the API checks the admin role on every admin endpoint anyway. */}
        <Stack.Protected guard={roles.includes('admin')} redirectTo="/dashboard">
          <Stack.Screen name="admin-onboarding" />

          {/* Same for the admin pages: the admin walkthrough first. */}
          <Stack.Protected guard={!adminOnboardingDue} redirectTo="/admin-onboarding">
            <Stack.Screen name="admin-dashboard" />
            <Stack.Screen name="admin-monitoring" />
          </Stack.Protected>
        </Stack.Protected>
      </Stack.Protected>
    </Stack>
  );
}
