// Knows who is logged in (and their roles), and shares it with every screen.
// Any screen can call:  const { user, roles, isLoading } = useAuth();

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../firebase';
import { getOrCreateUserRoles } from './createUserDoc';
import { Role } from '../types/user';

// The shape of what we share.
type AuthState = {
  user: User | null;   // the logged-in user, or null = nobody
  roles: Role[];       // e.g. ['user'] or ['admin', 'user']; [] when logged out
  isLoading: boolean;  // true until we know who is logged in AND their roles
};

// The "channel" screens read from. Starts as: nobody, no roles, still loading.
const AuthContext = createContext<AuthState>({ user: null, roles: [], isLoading: true });

// Wraps the app. `children` = everything inside <AuthProvider>...</AuthProvider>.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Runs ONCE when the app starts (the empty [] at the end = "only once").
  useEffect(() => {
    // 1. Subscribe: Firebase calls this function on every login / logout / refresh.
    //    `async` because we also WAIT for our API (the roles, from Postgres).
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      let newRoles: Role[] = [];  // logged out: no roles
      if (firebaseUser) {
        try {
          // Logged in: make sure the user's row exists in Postgres, and get the roles.
          newRoles = await getOrCreateUserRoles(firebaseUser);
        } catch (e) {
          // The API failed (e.g. no internet, or the API is down). Treat as "no special roles".
          console.error('Could not load user roles', e);
        }
      }

      // While we waited for the API, the user may have logged out or switched accounts.
      // Then this answer is stale: the newer login/logout runs this function again and sets the state.
      if (auth.currentUser?.uid !== firebaseUser?.uid) return;

      setRoles(newRoles);
      setUser(firebaseUser);    // 2. who is logged in (or null)
      setIsLoading(false);      // 3. we have the answer, stop waiting
    });

    // 4. Cleanup: stop listening if this component is ever removed.
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, roles, isLoading }}>{children}</AuthContext.Provider>
  );
}

// The shortcut screens use to read the shared value.
export function useAuth() {
  return useContext(AuthContext);
}
