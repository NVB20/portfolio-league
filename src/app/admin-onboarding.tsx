// URL "/admin-onboarding": the admin walkthrough. Admins only (see _layout.tsx); an admin who has not seen it yet
// is sent here from the admin pages.

import OnboardingScreen from '../screens/OnboardingScreen';

export default function AdminOnboarding() {
  return <OnboardingScreen flow="admin" />;
}
