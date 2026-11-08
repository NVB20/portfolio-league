// The logged-in user's theme (D-007): their saved choice from the API (users.theme),
// or the device setting while we don't know it yet (logged out, or the API failed).

import { useColorScheme } from 'react-native';
import { useAuth } from './auth/AuthProvider';
import { dark, light } from './theme';
import { Theme } from './types/user';

export function useTheme() {
  const { me, setTheme } = useAuth();
  const device = useColorScheme();
  const theme: Theme = me?.theme ?? (device === 'light' ? 'light' : 'dark');
  return { theme, colors: theme === 'dark' ? dark : light, setTheme };
}
