// URL "/onboarding": the player walkthrough. Logged-in users only (see _layout.tsx); a player who has not seen
// it yet is sent here from the other pages.

import OnboardingScreen from '../screens/OnboardingScreen';

export default function Onboarding() {
  return <OnboardingScreen flow="player" />;
}
