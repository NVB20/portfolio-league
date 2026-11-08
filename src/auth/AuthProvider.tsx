// Knows who is logged in (and their row from our API: roles, theme), and shares it with every screen.
// Any screen can call:  const { user, roles, me, isLoading, setTheme } = useAuth();

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../firebase';
import { getOrCreateMe, saveTheme } from './createUserDoc';
import { Role, Theme, UserDoc } from '../types/user';

// The shape of what we share.
type AuthState = {
  user: User | null;     // the logged-in Firebase user, or null = nobody
  me: UserDoc | null;    // our API's row for that user; null when logged out or the API failed
  roles: Role[];         // shortcut for me.roles; [] when logged out
  isLoading: boolean;    // true until we know who is logged in AND their row
  setTheme: (theme: Theme) => void;   // changes the theme now, saves it in the background
};

// The "channel" screens read from. Starts as: nobody, no roles, still loading.
const AuthContext = createContext<AuthState>({
  user: null,
  me: null,
  roles: [],
  isLoading: true,
  setTheme: () => {},
});

// Wraps the app. `children` = everything inside <AuthProvider>...</AuthProvider>.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<UserDoc | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Runs ONCE when the app starts (the empty [] at the end = "only once").
  useEffect(() => {
    // 1. Subscribe: Firebase calls this function on every login / logout / refresh.
    //    `async` because we also WAIT for our API (the user's row, from Postgres).
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      let newMe: UserDoc | null = null;  // logged out: no row
      if (firebaseUser) {
        try {
          // Logged in: make sure the user's row exists in Postgres, and get it.
          newMe = await getOrCreateMe();
        } catch (e) {
          // The API failed (e.g. no internet, or the API is down). Treat as "no special roles".
          console.error('Could not load the user from the API', e);
        }
      }

      // While we waited for the API, the user may have logged out or switched accounts.
      // Then this answer is stale: the newer login/logout runs this function again and sets the state.
      if (auth.currentUser?.uid !== firebaseUser?.uid) return;

      setMe(newMe);
      setUser(firebaseUser);    // 2. who is logged in (or null)
      setIsLoading(false);      // 3. we have the answer, stop waiting
    });

    // 4. Cleanup: stop listening if this component is ever removed.
    return unsubscribe;
  }, []);

  // Optimistic: the screen switches theme at once; if saving fails, it switches back.
  // (The request is sent here, not inside a setMe updater: React may run updaters twice.)
  const setTheme = useCallback(
    (theme: Theme) => {
      if (!me || me.theme === theme) return;
      const previous = me.theme;
      setMe({ ...me, theme });
      saveTheme(theme).catch((e) => {
        console.error('Could not save the theme', e);
        setMe((now) => (now ? { ...now, theme: previous } : now));
      });
    },
    [me],
  );

  return (
    <AuthContext.Provider value={{ user, me, roles: me?.roles ?? [], isLoading, setTheme }}>
      {children}
    </AuthContext.Provider>
  );
}

// The shortcut screens use to read the shared value.
export function useAuth() {
  return useContext(AuthContext);
}
