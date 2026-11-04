// The login / signup form. Part 1: UI and state only (no Firebase yet).

import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useThemeColors } from '../theme';

export default function LoginScreen() {
  const colors = useThemeColors();

  // useState = a value React remembers between redraws.
  // It gives back [currentValue, functionToChangeIt].
  const [email, setEmail] = useState('');

  const [password, setPassword] = useState('');

  // false = password hidden (dots), true = password visible.
  const [showPassword, setShowPassword] = useState(false);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.primary }]}>Welcome</Text>

      <TextInput
        style={[styles.input, { color: colors.textHeading, borderColor: colors.divider }]}
        placeholder="Email"
        placeholderTextColor={colors.textBody}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      {/* A row: the password box, with a Show/Hide button on its right. */}
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.rowInput, { color: colors.textHeading, borderColor: colors.divider }]}
          placeholder="Password"
          placeholderTextColor={colors.textBody}
          autoCapitalize="none"
          secureTextEntry={!showPassword}
          value={password}
          onChangeText={setPassword}
        />
        {/* Tap to flip between showing and hiding the password. */}
        <Pressable style={styles.showButton} onPress={() => setShowPassword(!showPassword)}>
          <Text style={{ color: colors.primary }}>{showPassword ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>

      {/* Main action: filled button. The Firebase onPress is added in part 4b. */}
      <Pressable style={[styles.button, { backgroundColor: colors.primary }]}>
        <Text style={[styles.buttonText, { color: colors.background }]}>Sign in</Text>
      </Pressable>

      {/* Second action: outlined button (border, no fill), so it looks less important. */}
      <Pressable style={[styles.button, styles.outlined, { borderColor: colors.primary }]}>
        <Text style={[styles.buttonText, { color: colors.primary }]}>Sign up</Text>
      </Pressable>
    </View>
  );
}

// Layout only. Colors come from the theme above, so they change with dark/light.
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16 },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700' },
  outlined: { borderWidth: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, // children side by side
  rowInput: { flex: 1 },                                       // box takes all leftover width
  showButton: { padding: 8 },
});
