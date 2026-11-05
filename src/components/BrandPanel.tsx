// The dark "brand" side of the login page: app name, headline, and 3 selling points.
// It always uses the DARK colors, even in light mode, so it looks the same
// for everyone (like the right side of the reference design).

import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { dark } from '../theme';

const points = [
  'מסחר במניות אמיתיות, בלי סיכון',
  'תחרות שבועית וטבלת דירוג',
  'תחזית יומית ורצפים',
];

export default function BrandPanel() {
  return (
    <View style={styles.panel}>
      <View style={styles.eyebrowRow}>
        <View style={styles.eyebrowLine} />
        <Text style={styles.eyebrow}>Portfolio League</Text>
      </View>

      <Text style={styles.headline}>לומדים להשקיע.{'\n'}מתחרים על הפסגה.</Text>

      <Text style={styles.subtitle}>
        תיק וירטואלי של ₪1,000,000, מניות מת״א ומארה״ב, ותחרות שבועית מול כולם.
      </Text>

      {/* .map turns each string in `points` into one row on screen. */}
      {points.map((point) => (
        <View key={point} style={styles.pointRow}>
          <Ionicons name="checkmark" size={18} color={dark.primary} />
          <Text style={styles.point}>{point}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: dark.surfaceChart, justifyContent: 'center', padding: 64, gap: 16 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrowLine: { width: 40, height: 1, backgroundColor: dark.primary },
  eyebrow: { color: dark.primary, fontSize: 14, letterSpacing: 1 },
  headline: { color: dark.textHeading, fontSize: 52, fontWeight: '800', lineHeight: 64 },
  subtitle: { color: dark.textBody, fontSize: 18, lineHeight: 28, maxWidth: 480, marginBottom: 16 },
  pointRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  point: { color: dark.textHeading, fontSize: 16 },
});
