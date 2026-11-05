// The first screen after login. For now: a blank white page with a title.

import { View, Text, StyleSheet } from 'react-native';

export default function DashboardScreen() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Dashboard</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 32, fontWeight: '800' },
});
