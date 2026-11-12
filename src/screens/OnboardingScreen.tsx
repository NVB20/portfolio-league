// The two walkthroughs, one screen: flow 'player' (/onboarding, shown the first time a player logs in) and flow
// 'admin' (/admin-onboarding, the first time an admin opens the admin side). Both can be opened again from the
// user menu. The step is local state, so leaving and coming back starts from step 1.
//
// "Skip" does not leave: it jumps to the last step, the recap. Only the last step's buttons end the walkthrough:
// they first record it as seen (AuthProvider.markOnboardingSeen updates `me` at once, so the redirect guard in
// _layout.tsx already lets the user through), then go on:
//   player: "למסך המסחר" -> /trade; "קודם לסקירת התיק" -> /dashboard
//   admin:  "ללוח הניהול" -> /admin-dashboard
// Opening it when it was already seen is fine (that is the reopen path): marking is then a no-op.

import { useState } from 'react';
import { router } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import { AdminStepView } from '../components/onboarding/AdminStepView';
import { PlayerStepView } from '../components/onboarding/PlayerStepView';
import { AFTER, stepCount, type OnboardingFlow } from '../onboarding/steps';

export default function OnboardingScreen({ flow }: { flow: OnboardingFlow }) {
  const { markOnboardingSeen } = useAuth();
  const [index, setIndex] = useState(0);
  const last = stepCount(flow) - 1;

  const next = () => setIndex((i) => Math.min(i + 1, last));
  const skip = () => setIndex(last);
  const back = () => setIndex((i) => Math.max(i - 1, 0));
  const restart = () => setIndex(0);

  // dismissTo (expo-router: pop back to `to` if it is already in the stack, otherwise replace this screen with it):
  // first run, the stack is just [walkthrough] and it becomes [to], so "back" cannot return here; reopened from
  // the menu, the stack is [..., to, walkthrough] and it pops to the page the user came from instead of piling a
  // second copy of it on top.
  const leave = (to: '/trade' | '/dashboard' | '/admin-dashboard') => {
    markOnboardingSeen(flow);
    router.dismissTo(to);
  };

  if (flow === 'admin') {
    return (
      <AdminStepView
        index={index}
        onNext={next}
        onBack={back}
        onSkip={skip}
        onFinish={() => leave(AFTER.admin.primary)}
        onRestart={restart}
      />
    );
  }

  return (
    <PlayerStepView
      index={index}
      onNext={next}
      onBack={back}
      onSkip={skip}
      onTrade={() => leave(AFTER.player.primary)}
      onDashboard={() => leave(AFTER.player.secondary)}
      onRestart={restart}
    />
  );
}
