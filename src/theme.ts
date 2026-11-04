// All app colors live here. Screens never write a hex code directly.
// They ask for a token (e.g. colors.primary), so switching dark/light
// only changes WHICH set of colors is used, not every screen.

import { useColorScheme } from 'react-native';

// Light theme: suggested values, adjust if you like.
export const light = {
  primary: '#0B8A68',        // darker mint, so it's readable on white
  background: '#F4FAF8',
  backgroundGlow: '#E3F4EE',
  surfaceChart: '#FFFFFF',
  textHeading: '#0B2B30',    // our dark background color becomes the text color
  textBody: '#3D5A58',
  divider: '#D3E3DF',
  negative: '#D93036',
};

// Dark theme: from the "Theme colors" table in tech-stack.md.
export const dark = {
  primary: '#5FE3B8',        // mint green
  background: '#0B2B30',
  backgroundGlow: '#0F3D3B', // deep teal, for the glow behind the logo
  surfaceChart: '#0E2233',   // navy, for charts and tables
  textHeading: '#FFFFFF',
  textBody: '#C9D6D3',
  divider: '#2E4E50',
  negative: '#E5484D',       // red, for losses
};

// TODO 2: finish this function. It returns the right color set.
//   - useColorScheme() returns 'dark' or 'light' (the phone/browser setting).
//   - If it is 'dark', return dark; otherwise return light.
//   Hint: you can do it in one line with  condition ? a : b
export function useThemeColors() {
  const scheme = useColorScheme();
  return scheme ? 'dark' : light;
}
