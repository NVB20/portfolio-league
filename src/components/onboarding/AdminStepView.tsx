// One step of the admin walkthrough: a dialog with two panes. Wide screens: the explanation on the right (it
// comes first in a right-to-left row) and the example card, 420px, on the left. A phone (or any window too
// narrow for both): one column, explanation then example, with the buttons at the very end so nobody presses
// "next" before the example. The page scrolls when the window is short.

import { useEffect, useRef } from 'react';
import { ScrollView, type ScrollViewInstance, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../useTheme';
import { rtl, useLayout } from '../dashboard/layout';
import { ADMIN_STEPS, ADMIN_UI, stepOf } from '../../onboarding/steps';
import { AdminLeft, AdminRight } from './AdminPanes';
import { PrimaryButton, TextLink } from './Buttons';
import { ProgressBar } from './ProgressBar';

const SPLIT_AT = 860;     // below this width the two panes stack
const RIGHT_PANE = 420;

type Props = {
  index: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;     // the last step's button
  onRestart: () => void;
};

export function AdminStepView({ index, onNext, onBack, onSkip, onFinish, onRestart }: Props) {
  const { colors } = useTheme();
  const { width } = useLayout();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance>(null);
  const step = ADMIN_STEPS[index];
  const total = ADMIN_STEPS.length;
  const first = index === 0;
  const last = index === total - 1;
  const split = width >= SPLIT_AT;

  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [index]);

  const header = (
    <View style={styles.header}>
      <Text style={[styles.eyebrow, { color: colors.fg }]}>{`${ADMIN_UI.eyebrow} · ${stepOf(index + 1, total)}`}</Text>
      <ProgressBar step={index} total={total} segment={24} />
    </View>
  );

  const explain = (
    <View style={styles.explain}>
      {/* A polite live region: a screen reader reads the new headline when the step changes. */}
      <Text accessibilityRole="header" aria-live="polite" style={[styles.title, { color: colors.fg, fontSize: split ? step.titleSize : Math.min(step.titleSize, 28), lineHeight: Math.round((split ? step.titleSize : Math.min(step.titleSize, 28)) * 1.2) }]}>
        {step.title}
      </Text>
      <AdminLeft blocks={step.left} />
    </View>
  );

  // Back / skip on one side, the primary button on the other.
  const nav = (
    <View style={styles.nav}>
      {first ? (
        <TextLink label={ADMIN_UI.skip} accessibilityLabel={ADMIN_UI.skip} onPress={onSkip} color={colors.muted} />
      ) : (
        <TextLink label={ADMIN_UI.back} accessibilityLabel={ADMIN_UI.back} onPress={onBack} color={colors.muted} fontSize={15} />
      )}
      <PrimaryButton label={step.next} onPress={last ? onFinish : onNext} height={48} fontSize={16} radius={12} arrow={!last} />
    </View>
  );

  const example = (
    <View
      style={[
        { backgroundColor: colors.inverse, gap: step.rightGap },
        split ? styles.exampleSide : styles.exampleStacked,
      ]}
    >
      <AdminRight blocks={step.right} onRestart={onRestart} />
    </View>
  );

  return (
    <ScrollView
      ref={scroll}
      style={[styles.page, rtl, { backgroundColor: colors.page }]}
      contentContainerStyle={[styles.scroll, split && styles.scrollWide, split && { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.dialog, split ? [styles.dialogWide, { borderColor: colors.line2, backgroundColor: colors.page }] : styles.dialogNarrow]}>
        {split ? (
          <>
            <View style={styles.left}>
              {header}
              <View style={styles.leftBody}>{explain}</View>
              {nav}
            </View>
            {example}
          </>
        ) : (
          <>
            <View style={[styles.stackedTop, { paddingTop: 20 + insets.top }]}>
              {header}
              {explain}
            </View>
            {example}
            <View style={[styles.stackedNav, { paddingBottom: 20 + insets.bottom }]}>{nav}</View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { flexGrow: 1 },
  scrollWide: { alignItems: 'center', justifyContent: 'center', padding: 24 },

  // wide: a 960 dialog at least 600 tall
  dialog: { width: '100%' },
  dialogWide: { maxWidth: 960, minHeight: 600, flexDirection: 'row', borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  dialogNarrow: { flexGrow: 1 },

  left: { flex: 1, minWidth: 0, paddingTop: 36, paddingBottom: 32, paddingHorizontal: 40 },
  leftBody: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
    exampleSide: { width: RIGHT_PANE, justifyContent: 'center', paddingVertical: 36, paddingHorizontal: 32 },
  exampleStacked: { paddingVertical: 28, paddingHorizontal: 24 },

  stackedTop: { paddingTop: 20, paddingHorizontal: 24, paddingBottom: 24, gap: 20 },
  stackedNav: { paddingHorizontal: 24, paddingVertical: 20 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 24 },
  eyebrow: { fontSize: 13, fontWeight: '500' },
  explain: { gap: 16 },
  title: { fontWeight: '700' },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
});
