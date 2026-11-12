// After login: make sure the user has a row in Postgres, and return it (email, roles, theme).
// The API does the work (POST /me): it creates the row (and the ₪1,000,000 portfolio) the first time,
// and just returns it on later logins. Only the API decides roles, never the app.

import { apiFetch } from '../api';
import { OnboardingFlow, Theme, UserDoc } from '../types/user';

export function getOrCreateMe(): Promise<UserDoc> {
  // No uid is sent: the API reads who is logged in from the token that apiFetch adds.
  return apiFetch<UserDoc>('/me', { method: 'POST' });
}

// Saves the dark/light choice on the user's row (D-007). Returns the updated row.
export function saveTheme(theme: Theme): Promise<UserDoc> {
  return apiFetch<UserDoc>('/me/theme', { method: 'PATCH', body: JSON.stringify({ theme }) });
}

// Records that the user has seen a walkthrough (POST /me/onboarding/seen). Safe to repeat. Returns the updated row.
export function saveOnboardingSeen(flow: OnboardingFlow): Promise<UserDoc> {
  return apiFetch<UserDoc>('/me/onboarding/seen', { method: 'POST', body: JSON.stringify({ flow }) });
}
