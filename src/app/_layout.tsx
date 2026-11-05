// The wrapper around EVERY screen in src/app, and the place where we block
// logged-out users. Because it wraps everything, nothing gets past it.

import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from '../auth/AuthProvider';

export default function RootLayout() {
  // AuthProvider must be OUTSIDE the guard, so the guard can call useAuth().
  return (
    <AuthProvider>
      <GuardedStack />
    </AuthProvider>
  );
}

function GuardedStack() {
  const { user, isLoading } = useAuth();

  // Firebase hasn't answered yet: show a spinner and NO screen at all.
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF' }}>
        <ActivityIndicator size="large" />
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
      </Stack.Protected>
    </Stack>
  );
}
