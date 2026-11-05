// The shape of a document in the Firestore `users` collection.
// Firestore itself doesn't check field names. This type makes TypeScript check them,
// so a typo like `role` instead of `roles` is a compile error.

// A role can only be one of these two words.
export type Role = 'admin' | 'user';

export type UserDoc = {
  email: string;
  roles: Role[];   // several roles allowed, e.g. ['admin', 'user']
};
