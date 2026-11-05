// Shown for any URL that matches no file in src/app (the "+" makes it special).
// Expo shows this page OUTSIDE our Stack.Protected rules, so it checks login itself:
// logged-out visitors never see it, they are sent to /login.

import { Redirect, Link } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { light } from '../theme';

export default function NotFound() {
  const { user } = useAuth();

  // The lock: nobody logged in -> go to login, show nothing here.
  if (user === null) {
    return <Redirect href="/login" />;
  }

  return (
    <View style={[styles.page, { direction: 'rtl' }]}>
      <Text style={styles.code}>404</Text>
      <Text style={styles.title}>הדף לא נמצא</Text>
      <Link href="/dashboard" style={styles.link}>חזרה ללוח הבקרה</Link>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: light.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
  code: { fontSize: 64, fontWeight: '800', color: light.primary },
  title: { fontSize: 24, fontWeight: '700', color: light.textHeading },
  link: { fontSize: 16, color: light.primary, textDecorationLine: 'underline' },
});
