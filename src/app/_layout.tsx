// The wrapper around EVERY screen in src/app, and the place where we block
// logged-out users. Because it wraps everything, nothing gets past it.

import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { usePresence } from '../auth/usePresence';
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
      {/* Logged OUT only: the login page. */}
      <Stack.Protected guard={user === null}>
        <Stack.Screen name="login" />
      </Stack.Protected>

      {/* Logged IN only: everything else. Logged-out visitors go to /login. */}
      <Stack.Protected guard={user !== null} redirectTo="/login">
        <Stack.Screen name="index" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="trade" />
        <Stack.Screen name="leaderboard" />

        {/* Admins only. Everyone else goes back to their dashboard.
            This is a convenience: the API checks the admin role on every admin endpoint anyway. */}
        <Stack.Protected guard={roles.includes('admin')} redirectTo="/dashboard">
          <Stack.Screen name="admin-dashboard" />
          <Stack.Screen name="admin-monitoring" />
        </Stack.Protected>
      </Stack.Protected>
    </Stack>
  );
}
