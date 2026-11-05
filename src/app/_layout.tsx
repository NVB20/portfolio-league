// The wrapper around EVERY screen in src/app.
// <AuthProvider> = every screen inside can call useAuth() to know who is logged in.
// <Stack> = screens stack on top of each other (like browser history).
// headerShown: false = hide the default top bar; our screens draw their own design.

import { Stack } from 'expo-router';
import { AuthProvider } from '../auth/AuthProvider';

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
