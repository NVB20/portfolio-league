// After login: make sure the user has a row in Postgres, and return the user's roles.
// The API does the work (POST /me): it creates the row the first time as a normal user,
// and just returns it on later logins. Only the API decides roles, never the app.

import { User } from 'firebase/auth';
import { apiFetch } from '../api';
import { Role, UserDoc } from '../types/user';

// `_user` is unused: the API reads who is logged in from the token that apiFetch sends.
export async function getOrCreateUserRoles(_user: User): Promise<Role[]> {
  const me = await apiFetch<UserDoc>('/me', { method: 'POST' });
  return me.roles;
}
