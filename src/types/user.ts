// The user data the API returns from POST /me (a row of the Postgres `users` table).
// This type makes TypeScript check field names, so a typo like `role` instead of `roles` is a compile error.

// A role can only be one of these two words.
export type Role = 'admin' | 'user';

export type Theme = 'dark' | 'light';

export type UserDoc = {
  email: string;
  roles: Role[];   // several roles allowed, e.g. ['admin', 'user']
  theme: Theme;    // D-007
};
