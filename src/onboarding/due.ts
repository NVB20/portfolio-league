// Who still has to see a walkthrough. Pure, so _layout.tsx (the redirect) and AuthProvider (marking it seen)
// agree on one rule.
//
// Due only when the API said so: the field is exactly null. No row (me is null: the API failed) and a missing
// field (undefined: an older API) both count as "seen", so a player is never trapped on a screen we can't get them
// out of. Keep the strict `=== null`: `!field` or `== null` would turn undefined into "due", send every player to a
// walkthrough whose "seen" request that API would answer with a 404.

import type { OnboardingFlow, UserDoc } from '../types/user';

export function onboardingDue(me: UserDoc | null, flow: OnboardingFlow): boolean {
  if (!me) return false;
  return (flow === 'admin' ? me.adminOnboardedAt : me.onboardedAt) === null;
}
