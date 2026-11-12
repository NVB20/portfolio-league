// Knows who is logged in (and their row from our API: roles, theme), and shares it with every screen.
// Any screen can call:  const { user, roles, me, isLoading, setTheme, markOnboardingSeen } = useAuth();

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../firebase';
import { getOrCreateMe, saveOnboardingSeen, saveTheme } from './createUserDoc';
import { onboardingDue } from '../onboarding/due';
import { OnboardingFlow, Role, Theme, UserDoc } from '../types/user';

// The shape of what we share.
type AuthState = {
  user: User | null;     // the logged-in Firebase user, or null = nobody
  me: UserDoc | null;    // our API's row for that user; null when logged out or the API failed
  roles: Role[];         // shortcut for me.roles; [] when logged out
  isLoading: boolean;    // true until we know who is logged in AND their row
  setTheme: (theme: Theme) => void;   // changes the theme now, saves it in the background
  markOnboardingSeen: (flow: OnboardingFlow) => void;   // the walkthrough counts as seen now, saved in the background
};

// The "channel" screens read from. Starts as: nobody, no roles, still loading.
const AuthContext = createContext<AuthState>({
  user: null,
  me: null,
  roles: [],
  isLoading: true,
  setTheme: () => {},
  markOnboardingSeen: () => {},
});

// After a failed "seen" save: wait this long (ms) before each of the 3 retries.
const SEEN_RETRY_DELAYS = [2_000, 5_000, 15_000];

// Wraps the app. `children` = everything inside <AuthProvider>...</AuthProvider>.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<UserDoc | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Walkthroughs whose "seen" is on `me` already but not yet saved by the API (the save failed, or is still
  // running), and the ones being sent right now. Refs, because they are bookkeeping, not something to draw.
  // `session` changes on every login/logout, so a retry that was waiting for the previous user stops.
  const unsavedSeen = useRef(new Set<OnboardingFlow>());
  const sendingSeen = useRef(new Set<OnboardingFlow>());
  const session = useRef(0);

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

      session.current += 1;
      unsavedSeen.current = new Set();
      sendingSeen.current = new Set();
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

  // Sends "seen" and, when that fails, tries again up to 3 times (2 s, 5 s, 15 s later). The endpoint is safe to
  // repeat. On success the server's value replaces our optimistic one. It gives up quietly when the user logged
  // out or switched account while it waited: the next login asks the API afresh.
  const sendSeen = useCallback(async (flow: OnboardingFlow, uid: string) => {
    const unsaved = unsavedSeen.current;
    const sending = sendingSeen.current;
    const mine = session.current;
    const field = flow === 'admin' ? 'adminOnboardedAt' : 'onboardedAt';
    const stale = () => session.current !== mine || auth.currentUser?.uid !== uid;
    sending.add(flow);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await saveOnboardingSeen(flow);
          if (stale()) return;
          unsaved.delete(flow);
          setMe((now) => (now && saved[field] ? { ...now, [field]: saved[field] } : now));
          return;
        } catch (e) {
          console.error('Could not save that the walkthrough was seen', e);
          if (stale() || attempt >= SEEN_RETRY_DELAYS.length) return;
          await new Promise((resolve) => setTimeout(resolve, SEEN_RETRY_DELAYS[attempt]));
          if (stale()) return;
        }
      }
    } finally {
      sending.delete(flow);
    }
  }, []);

  // Optimistic too: `me` gets its timestamp at once, so the redirect guard in _layout.tsx lets the player through
  // the moment they finish. Unlike the theme it is NOT put back when saving fails: that would send them straight
  // back to the walkthrough they just left. Instead the flow stays in `unsavedSeen` and is retried (sendSeen);
  // if all retries fail, the next call here for that flow (finishing a reopened walkthrough) sends it again.
  // The worst case left is seeing the walkthrough once more at the next login.
  const markOnboardingSeen = useCallback(
    (flow: OnboardingFlow) => {
      const uid = auth.currentUser?.uid;
      if (!me || !uid) return;
      if (onboardingDue(me, flow)) {
        const field = flow === 'admin' ? 'adminOnboardedAt' : 'onboardedAt';
        setMe({ ...me, [field]: new Date().toISOString() });
        unsavedSeen.current.add(flow);
        sendSeen(flow, uid);
      } else if (unsavedSeen.current.has(flow) && !sendingSeen.current.has(flow)) {
        sendSeen(flow, uid);   // an earlier save gave up: send it again
      }
      // otherwise: already seen and saved (or unknown): nothing to do
    },
    [me, sendSeen],
  );

  return (
    <AuthContext.Provider value={{ user, me, roles: me?.roles ?? [], isLoading, setTheme, markOnboardingSeen }}>
      {children}
    </AuthContext.Provider>
  );
}

// The shortcut screens use to read the shared value.
export function useAuth() {
  return useContext(AuthContext);
}
