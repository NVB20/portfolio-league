// Knows who is logged in, and shares it with every screen.
// Any screen can call:  const { user, isLoading } = useAuth();

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../firebase';

// The shape of what we share.
type AuthState = {
  user: User | null;   // the logged-in user, or null = nobody
  isLoading: boolean;  // true until Firebase answers the first time
};

// The "channel" screens read from. Starts as: nobody, still loading.
const AuthContext = createContext<AuthState>({ user: null, isLoading: true });

// Wraps the app. `children` = everything inside <AuthProvider>...</AuthProvider>.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Runs ONCE when the app starts (the empty [] at the end = "only once").
  useEffect(() => {
    // 1. Subscribe: Firebase calls this function on every login / logout / refresh.
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);   // 2. who is logged in (or null)
      setIsLoading(false);     // 3. Firebase answered, stop waiting
    });

    // 4. Cleanup: stop listening if this component is ever removed.
    return unsubscribe;
  }, []);

  return <AuthContext.Provider value={{ user, isLoading }}>{children}</AuthContext.Provider>;
}

// The shortcut screens use to read the shared value.
export function useAuth() {
  return useContext(AuthContext);
}
