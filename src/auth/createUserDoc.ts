// After login: make sure users/{uid} exists, and return the user's roles.
// - First login ever -> create the document as a normal user.
// - Later logins     -> just read the roles that are saved there.

import { User } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { Role, UserDoc } from '../types/user';

export async function getOrCreateUserRoles(user: User): Promise<Role[]> {
  // A "reference" = the address of one document: users/<uid>. It doesn't read anything yet.
  const ref = doc(db, 'users', user.uid);

  // Read the document (await: wait for Firestore's answer).
  const snapshot = await getDoc(ref);

  // Already exists: return its roles.
  if (snapshot.exists()) {
    return (snapshot.data() as UserDoc).roles;
  }

  // First login: create it. The Security Rules only accept EXACTLY these 3 fields,
  // and roles must be ['user'] (see firestore.rules).
  const newUser = {
    email: user.email ?? '',          // ?? '' = use '' if Firebase has no email
    roles: ['user'] as Role[],
    createdAt: serverTimestamp(),     // the time on Google's server, not the user's clock
  };

  await setDoc(ref, newUser);

  return newUser.roles;
}
