// The login / signup page. UI and state only (Firebase comes in the next step).
// Wide screens: form + brand panel side by side. Narrow screens (phones): form only.

import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { light } from '../theme';
import BrandPanel from '../components/BrandPanel';

export default function LoginScreen() {
  // Design choice: the login form is ALWAYS white (light colors), even in dark mode.
  // The rest of the app will still follow the dark/light setting via useThemeColors().
  const colors = light;

  // useWindowDimensions gives the current screen size, and updates on resize.
  const { width } = useWindowDimensions();

  // Wide screen (900px or more) = show the brand panel. Narrow (phone) = form only.
  const isWide = width >= 900;

  // useState = a value React remembers between redraws.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // false = password hidden (dots), true = password visible.
  const [showPassword, setShowPassword] = useState(false);

  return (
    // direction: 'rtl' = Hebrew layout: rows start on the right.
    <View style={[styles.page, { direction: 'rtl', backgroundColor: colors.background }]}>
      {/* `isWide && <X />` = draw X only when isWide is true. */}
      {isWide && <BrandPanel />}

      <View style={styles.formSide}>
        <View style={styles.form}>
          <Text style={[styles.title, { color: colors.textHeading }]}>ברוכים הבאים</Text>
          <Text style={[styles.subtitle, { color: colors.textBody }]}>
            התחברו או צרו חשבון כדי להתחיל לשחק
          </Text>

          {/* Email: label above, then a bordered box with an icon and the input. */}
          <Text style={[styles.label, { color: colors.textHeading }]}>אימייל</Text>
          <View style={[styles.inputBox, { borderColor: colors.divider }]}>
            <Ionicons name="mail-outline" size={20} color={colors.textBody} />
            <TextInput
              style={[styles.input, { color: colors.textHeading }]}
              placeholder="name@example.com"
              placeholderTextColor={colors.textBody}
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </View>

          {/* Password: same box, plus an eye button that toggles showPassword. */}
          <Text style={[styles.label, { color: colors.textHeading }]}>סיסמה</Text>
          <View style={[styles.inputBox, { borderColor: colors.divider }]}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textBody} />
            <TextInput
              style={[styles.input, { color: colors.textHeading }]}
              placeholder="••••••••"
              placeholderTextColor={colors.textBody}
              autoCapitalize="none"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <Pressable onPress={() => setShowPassword(!showPassword)}>
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={colors.textBody}
              />
            </Pressable>
          </View>

          {/* Main action: filled. onPrimary = the text color that is readable
              on the primary color in the current theme. */}
          <Pressable style={[styles.button, { backgroundColor: colors.primary }]}>
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>התחברות</Text>
          </Pressable>

          {/* Second action: outlined (border, no fill). */}
          <Pressable style={[styles.button, styles.outlined, { borderColor: colors.primary }]}>
            <Text style={[styles.buttonText, { color: colors.primary }]}>הרשמה</Text>
          </Pressable>

          {/* "or" divider: line, text, line. */}
          <View style={styles.dividerRow}>
            <View style={[styles.line, { backgroundColor: colors.divider }]} />
            <Text style={{ color: colors.textBody }}>או</Text>
            <View style={[styles.line, { backgroundColor: colors.divider }]} />
          </View>

          {/* Google: UI only for now. Its onPress comes in the Google step. */}
          <Pressable style={[styles.button, styles.outlined, styles.googleRow, { borderColor: colors.divider }]}>
            <Ionicons name="logo-google" size={20} color={colors.textHeading} />
            <Text style={[styles.buttonText, { color: colors.textHeading }]}>המשך עם Google</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row' },                  // brand panel and form side by side
  formSide: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  form: { width: '100%', maxWidth: 420, gap: 10 },          // never wider than 420px
  title: { fontSize: 32, fontWeight: '800' },
  subtitle: { fontSize: 15, marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 6 },
  inputBox: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16 },
  button: { borderRadius: 8, padding: 14, alignItems: 'center', marginTop: 6 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  outlined: { borderWidth: 1.5 },
  googleRow: { flexDirection: 'row', justifyContent: 'center', gap: 10 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 8 },
  line: { flex: 1, height: 1 },
});
