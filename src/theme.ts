// All app colors live here. Screens never write a hex code directly.
// They ask for a token (e.g. colors.primary), so switching dark/light
// only changes WHICH set of colors is used, not every screen.
//
// The dashboard tokens (page, surface, ... inverse*) are copied from the mock-up's :root blocks
// (docs/design/dashboard/mockup.html, DD-11). The "inverse" card is the one card per section with the
// opposite polarity to the page: off-white on dark, navy on light (DD-04).

import { useColorScheme } from 'react-native';

// Dark theme: from the "Theme colors" table in tech-stack.md, plus the dashboard tokens.
export const dark = {
  primary: '#5FE3B8',        // mint green
  onPrimary: '#0B2B30',      // text ON a primary-colored button (dark on mint)
  background: '#0B2B30',
  backgroundGlow: '#0F3D3B', // deep teal, for the glow behind the logo
  surfaceChart: '#0E2233',   // navy, for charts and tables
  textHeading: '#FFFFFF',
  textBody: '#C9D6D3',
  divider: '#2E4E50',
  negative: '#E5484D',       // red, for losses

  // dashboard
  page: '#081214',           // darker than `background`, so the navy cards stand out
  surface: '#0E2233',
  surface2: '#15303B',
  fg: '#FFFFFF',
  muted: '#C9D6D3',
  faint: '#7A9792',
  line: '#1A2F34',
  line2: '#27454D',
  accent: '#5FE3B8',
  accentInk: '#081214',      // text on an accent fill
  accentTint: 'rgba(95, 227, 184, 0.14)',
  neg: '#E5484D',
  negTint: 'rgba(229, 72, 77, 0.14)',
  warn: '#F2B84B',
  warnTint: 'rgba(242, 184, 75, 0.14)',
  inverse: '#EEF6F3',
  inverseTile: '#FFFFFF',
  inverseLine: '#DCEAE4',
  inverseEdge: '#FFFFFF',
  inverseInk: '#0B2B30',
  inverseMuted: '#4E6C68',
  inverseWarn: '#8A5A00',
  // Check marks and "good" text inside the inverse card. WCAG contrast: 5.25:1 on `inverse` (#EEF6F3) and 5.76:1 on
  // `inverseTile` (#FFFFFF). (The light theme's accent #0A8262 is only 4.36:1 on `inverse`.)
  inverseGood: '#087456',
  avatarA: '#2A5A5E',
  avatarFg: '#7FB3A8',
  barBackground: 'rgba(8, 18, 20, 0.86)',   // the top bar: page color, slightly see-through
};

// Light theme. `primary`/`accent` is the deep green #0A8262: mint on white fails contrast (DD-11).
export const light: typeof dark = {
  primary: '#0A8262',
  onPrimary: '#FFFFFF',      // text ON a primary-colored button
  background: '#FFFFFF',
  backgroundGlow: '#E3F4EE',
  surfaceChart: '#FFFFFF',
  textHeading: '#0B2B30',    // our dark background color becomes the text color
  textBody: '#3D5A58',
  divider: '#D3E3DF',
  negative: '#D93036',

  // dashboard
  page: '#E6EEEB',
  surface: '#FFFFFF',
  surface2: '#EAF2EF',
  fg: '#0B2B30',
  muted: '#3D5A58',
  faint: '#64807B',
  line: '#D3E3DF',
  line2: '#B5CCC6',
  accent: '#0A8262',
  accentInk: '#FFFFFF',
  accentTint: 'rgba(10, 130, 98, 0.12)',
  neg: '#D93036',
  negTint: 'rgba(217, 48, 54, 0.10)',
  warn: '#9A6400',
  warnTint: 'rgba(154, 100, 0, 0.12)',
  inverse: '#0E2233',
  inverseTile: '#1A3346',
  inverseLine: '#2C4A5E',
  inverseEdge: '#1F3B50',
  inverseInk: '#FFFFFF',
  inverseMuted: '#B9CBC7',
  inverseWarn: '#F6C45C',
  // Mint, as in `fixed.inverseAccent`. WCAG contrast: 10.16:1 on `inverse` (#0E2233) and 8.20:1 on `inverseTile` (#1A3346).
  inverseGood: '#5FE3B8',
  avatarA: '#CFE6DF',
  avatarFg: '#1F4A4E',
  barBackground: 'rgba(230, 238, 235, 0.86)',
};

// The same in both themes: inside the inverse card the accent is always mint, because mint
// reads on navy and on off-white alike; the warning chip is a fixed bright amber.
export const fixed = {
  inverseAccent: '#5FE3B8',
  inverseAccentInk: '#081214',
  warnFill: '#F2B84B',
  warnFillInk: '#6B4500',
  // Other players' initials on the leaderboard (LD-06): five dark fills with a white letter pass contrast on
  // both themes, so one set serves both. The API picks the fill (LeaderboardRow.avatar, 0..4).
  avatarFills: ['#2A5A5E', '#3B4F7A', '#5A4A7A', '#7A5A3B', '#2F6B5A'] as const,
  avatarInk: '#FFFFFF',
};

export type Colors = typeof dark;

// Returns the color set that matches the user's phone/browser setting.
// Used where we don't know the user yet (login). Logged-in screens use useTheme() from src/useTheme.ts.
export function useThemeColors() {
  const scheme = useColorScheme(); // 'dark', 'light', or null (unknown)
  return scheme === 'dark' ? dark : light;
}
