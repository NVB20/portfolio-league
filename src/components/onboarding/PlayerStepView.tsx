// One step of the player walkthrough, phone-first (390 wide): progress and "skip" on top, the picture in the
// middle, the headline and text under it, the buttons at the bottom. On a wide screen it is the same column,
// centered, 480px at most. The page scrolls when the window is too short for it, so nothing clips.

import { useEffect, useRef } from 'react';
import { ScrollView, type ScrollViewInstance, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../useTheme';
import { rtl } from '../dashboard/layout';
import { PLAYER_STEPS, PLAYER_UI, stepLabel } from '../../onboarding/steps';
import { OutlineButton, PrimaryButton, TextLink } from './Buttons';
import { PlayerVisual } from './PlayerVisuals';
import { ProgressBar } from './ProgressBar';

type Props = {
  index: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onTrade: () => void;       // last step: "למסך המסחר"
  onDashboard: () => void;   // last step: "קודם לסקירת התיק"
  onRestart: () => void;
};

export function PlayerStepView({ index, onNext, onBack, onSkip, onTrade, onDashboard, onRestart }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance>(null);
  const step = PLAYER_STEPS[index];
  const total = PLAYER_STEPS.length;
  const first = index === 0;
  const last = index === total - 1;

  // A new step starts at the top, also when the window is short enough to scroll.
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [index]);

  return (
    <ScrollView
      ref={scroll}
      style={[styles.page, rtl, { backgroundColor: colors.page }]}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.column, { paddingTop: Math.max(16, insets.top), paddingBottom: Math.max(24, insets.bottom) }]}>
        <View style={styles.header}>
          <ProgressBar step={index} total={total} label={stepLabel(index + 1, total)} />
          {/* The last step has nothing left to skip: an empty slot keeps the bar the same width. */}
          {last ? (
            <View style={styles.slot} />
          ) : (
            <TextLink label={PLAYER_UI.skip} accessibilityLabel={PLAYER_UI.skipLabel} onPress={onSkip} color={colors.muted} />
          )}
        </View>

        <View style={styles.visual}>
          <PlayerVisual visual={step.visual} />
        </View>

        <View style={[styles.text, { paddingBottom: first ? 28 : 24 }]}>
          {/* A polite live region: a screen reader reads the new headline when the step changes. */}
          <Text
            accessibilityRole="header"
            aria-live="polite"
            style={[styles.title, { color: colors.fg, fontSize: first ? 32 : 30 }]}
          >
            {step.title}
          </Text>
          <Text style={[styles.body, { color: colors.muted, fontSize: last ? 15 : 16 }]}>{step.body}</Text>
          {step.note ? <Text style={[styles.note, { color: colors.muted }]}>{step.note}</Text> : null}
        </View>

        {/* One tree for every step, so the button that was pressed stays mounted (keyboard focus is not dropped):
            "next" / "start" / "to trade" is always the same keyed button; only the siblings around it change. */}
        <View style={last ? styles.finish : styles.nav}>
          {!first && !last ? <OutlineButton key="back" label={PLAYER_UI.back} onPress={onBack} /> : null}
          <PrimaryButton
            key="primary"
            label={last ? PLAYER_UI.toTrade : first ? PLAYER_UI.start : PLAYER_UI.next}
            onPress={last ? onTrade : onNext}
            arrow={!last}
            grow={!last}
          />
          {last ? <OutlineButton key="dashboard" label={PLAYER_UI.toDashboard} onPress={onDashboard} height={50} /> : null}
          {last ? <TextLink key="restart" label={PLAYER_UI.restart} accessibilityLabel={PLAYER_UI.restart} onPress={onRestart} color={colors.muted} center /> : null}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  // The content is as tall as the window at least, so the buttons sit at the bottom of a tall screen.
  scroll: { flexGrow: 1, alignItems: 'center' },
  column: { width: '100%', maxWidth: 480, flexGrow: 1, paddingHorizontal: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 44 },
  slot: { width: 1, height: 44 },
  visual: { flexGrow: 1, justifyContent: 'center', paddingVertical: 16 },
  text: { gap: 12 },
  title: { fontWeight: '700', lineHeight: 38 },
  body: { lineHeight: 26 },
  note: { fontSize: 14, lineHeight: 22 },
  nav: { flexDirection: 'row', gap: 12 },
  finish: { gap: 10 },
});
