// The first screen after login. For now: a title, the user's email, and a logout button.
// After logout we do NOT navigate here: the guard sends the user to /login by itself.

import { View, Text, Pressable, StyleSheet } from 'react-native';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuth } from '../auth/AuthProvider';
import { light } from '../theme';

export default function DashboardScreen() {
  const { user } = useAuth();

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Dashboard</Text>
      {/* `?.` = if user is null, don't crash, just show nothing. */}
      <Text style={styles.email}>{user?.email}</Text>

      <Pressable style={styles.logout} onPress={() => signOut(auth)}>
        <Text style={styles.logoutText}>התנתקות</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: light.background, justifyContent: 'center', alignItems: 'center', gap: 12 },
  title: { fontSize: 32, fontWeight: '800', color: light.textHeading },
  email: { fontSize: 16, color: light.textBody },
  logout: { borderWidth: 1.5, borderColor: light.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24 },
  logoutText: { fontSize: 16, fontWeight: '700', color: light.primary },
});
