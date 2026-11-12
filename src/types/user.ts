// The user data the API returns from POST /me (a row of the Postgres `users` table).
// This type makes TypeScript check field names, so a typo like `role` instead of `roles` is a compile error.

// A role can only be one of these two words.
export type Role = 'admin' | 'user';

export type Theme = 'dark' | 'light';

// The two walkthroughs (src/onboarding): one for players, one for admins on the admin side.
export type OnboardingFlow = 'player' | 'admin';

export type UserDoc = {
  email: string;
  roles: Role[];   // several roles allowed, e.g. ['admin', 'user']
  theme: Theme;    // D-007
  // When the player / the admin first saw their walkthrough; null = not yet. Optional: an older API sends neither
  // field (undefined), and that counts as "seen" (see onboardingDue), so nobody is sent to a walkthrough the API
  // can't record.
  onboardedAt?: string | null;
  adminOnboardedAt?: string | null;
};
