// The wrapper around EVERY screen in src/app.
// <Stack> = screens stack on top of each other (like browser history).
// headerShown: false = hide the default top bar; our screens draw their own design.

import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
